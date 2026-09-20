import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

type EventRecord = {
  event_type?: string;
  tx_id?: string;
  contract_log?: { value?: { repr?: string } };
};

const input = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-04.2.signed.json";
const addressOutput = process.argv[2] ?? "fixtures/mainnet-100-addresses.json";
const evidenceOutput = process.argv[3] ?? "artifacts/mainnet-address-cohort-evidence.json";
const target = Number(process.env.COHORT_SIZE ?? 100);
const maxPages = Number(process.env.COHORT_MAX_PAGES ?? 100);
if (!Number.isSafeInteger(target) || target < 1 || target > 1_000) throw new Error("COHORT_SIZE must be 1..1000");
if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000) throw new Error("COHORT_MAX_PAGES must be 1..10000");

const payload = JSON.parse(await readFile(resolve(input), "utf8"));
const manifest = unwrapRegistryPayload(payload).manifest;
const baseUrl = (process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
const contracts = manifest.entries
  .filter((entry) => entry.enabled && ["zest-v2", "bitflow"].includes(entry.protocol))
  .filter((entry) =>
    entry.contractPrincipal.endsWith(".v0-market-vault") ||
    entry.contractPrincipal.includes(".v0-vault-") ||
    entry.protocol === "bitflow",
  )
  .sort((left, right) => (left.protocol === "bitflow" ? -1 : 1) - (right.protocol === "bitflow" ? -1 : 1));
const contractSet = new Set(manifest.entries.map((entry) => entry.contractPrincipal));
const principalPattern = /\((?:account|user|recipient|receiver|depositor|redeemer|sender|owner) '((?:SP|SM)[A-Z0-9]{20,50})\)/g;
const evidence = new Map<string, {
  address: string;
  protocols: Set<string>;
  contracts: Set<string>;
  eventCount: number;
  sampleTransactionIds: Set<string>;
}>();

async function events(contract: string, offset: number): Promise<EventRecord[]> {
  const response = await fetch(
    `${baseUrl}/extended/v1/contract/${encodeURIComponent(contract)}/events?limit=50&offset=${offset}`,
    {
      headers: {
        accept: "application/json",
        "user-agent": "riskos/0.1-evidence-cohort",
        ...(process.env.HIRO_API_KEY ? { "x-api-key": process.env.HIRO_API_KEY } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`Contract history ${contract} offset ${offset} returned ${response.status}`);
  const body = await response.json() as { results?: EventRecord[] };
  return body.results ?? [];
}

for (const entry of contracts) {
  for (let page = 0; page < maxPages && evidence.size < target; page += 1) {
    const pageEvents = await events(entry.contractPrincipal, page * 50);
    for (const event of pageEvents) {
      const repr = event.contract_log?.value?.repr ?? "";
      for (const match of repr.matchAll(principalPattern)) {
        const address = match[1]!;
        if (contractSet.has(address) || address === entry.contractPrincipal.split(".")[0]) continue;
        const current = evidence.get(address) ?? {
          address,
          protocols: new Set<string>(),
          contracts: new Set<string>(),
          eventCount: 0,
          sampleTransactionIds: new Set<string>(),
        };
        current.protocols.add(entry.protocol);
        current.contracts.add(entry.contractPrincipal);
        current.eventCount += 1;
        if (event.tx_id && current.sampleTransactionIds.size < 3) current.sampleTransactionIds.add(event.tx_id);
        evidence.set(address, current);
      }
    }
    if (pageEvents.length < 50) break;
  }
  if (evidence.size >= target) break;
}

if (evidence.size < target) {
  throw new Error(`Only ${evidence.size} event-backed addresses found; required ${target}`);
}
const cohort = [...evidence.values()].slice(0, target);
const addresses = cohort.map((item) => item.address);
const artifact = {
  kind: "riskos-mainnet-event-backed-address-cohort",
  generatedAt: new Date().toISOString(),
  registryVersion: manifest.version,
  source: `${baseUrl}/extended/v1/contract/{contract}/events`,
  meaning: "Every address is named in a canonical protocol contract-log event. This replaces synthetic addresses but is not an independent-calculator comparison result.",
  addressCount: addresses.length,
  addresses: cohort.map((item) => ({
    address: item.address,
    protocols: [...item.protocols].sort(),
    contracts: [...item.contracts].sort(),
    eventCount: item.eventCount,
    sampleTransactionIds: [...item.sampleTransactionIds],
  })),
};

await mkdir(dirname(resolve(addressOutput)), { recursive: true });
await mkdir(dirname(resolve(evidenceOutput)), { recursive: true });
await writeFile(resolve(addressOutput), `${JSON.stringify(addresses, null, 2)}\n`, "utf8");
await writeFile(resolve(evidenceOutput), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ addressCount: addresses.length, addressOutput: resolve(addressOutput), evidenceOutput: resolve(evidenceOutput) }, null, 2));
