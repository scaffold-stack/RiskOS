import { hexToCV, principalCV, uintCV, ClarityType, type ClarityValue } from "@stacks/transactions";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { asList, asTuple, asUint, responseErrorUint, tupleField, unwrapOk } from "../packages/adapters/src/clarity-values.js";
import { StacksReadOnlyClient } from "../packages/adapters/src/stacks-read-only-client.js";
import { fetchWithRateLimitRetry } from "../packages/adapters/src/http-retry.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

type HistoryUpdate = { amount: bigint; transactionId: string };
type HistoryState = {
  collateral: Map<number, HistoryUpdate[]>;
  debt: Map<number, HistoryUpdate[]>;
  eventCount: number;
};
type EventRecord = { tx_id?: string; contract_log?: { value?: { hex?: string } } };

const addresses = JSON.parse(await readFile(resolve(process.argv[2] ?? "fixtures/mainnet-100-addresses.json"), "utf8")) as string[];
if (new Set(addresses).size < 100) throw new Error("History comparison requires 100 unique addresses");
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-04.2.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
const marketVault = manifest.entries.find((entry) => entry.enabled && entry.contractPrincipal.endsWith(".v0-market-vault"));
const assets = manifest.entries.find((entry) => entry.enabled && entry.contractPrincipal.endsWith(".v0-assets"));
if (!marketVault || !assets) throw new Error("Signed registry is missing Zest market-vault/assets contracts");
const baseUrl = (process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
const stateBaseUrl = (process.env.STACKS_REFERENCE_API_URL ?? baseUrl).replace(/\/$/, "");
const headers = {
  accept: "application/json",
  "user-agent": "riskos/0.1-zest-history-comparison",
  ...(process.env.HIRO_API_KEY ? { "x-api-key": process.env.HIRO_API_KEY } : {}),
};
const cohort = new Set(addresses);
const historical = new Map<string, HistoryState>();
let eventPages = 0;
let contractEvents = 0;
const client = new StacksReadOnlyClient(
  stateBaseUrl,
  fetch,
  process.env.STACKS_REFERENCE_API_KEY ?? process.env.HIRO_API_KEY,
);
const pinned = await client.pinTip();

function principal(value: ClarityValue) {
  if (value.type !== ClarityType.PrincipalStandard && value.type !== ClarityType.PrincipalContract) throw new Error("Expected principal");
  return value.value;
}
function actionText(value: ClarityValue) {
  if (value.type !== ClarityType.StringASCII && value.type !== ClarityType.StringUTF8) throw new Error("Expected action string");
  return value.value;
}

for (let offset = 0; ; offset += 50) {
  const url = `${baseUrl}/extended/v1/contract/${encodeURIComponent(marketVault.contractPrincipal)}/events?limit=50&offset=${offset}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Zest history page ${offset} returned ${response.status}`);
  const page = await response.json() as { results?: EventRecord[] };
  const events = page.results ?? [];
  eventPages += 1;
  contractEvents += events.length;
  for (const event of events) {
    const hex = event.contract_log?.value?.hex;
    if (!hex || !event.tx_id) continue;
    try {
      const root = asTuple(hexToCV(hex));
      const action = actionText(tupleField(root, "action"));
      if (!new Set(["collateral-add", "collateral-remove", "debt-add-scaled", "debt-remove-scaled"]).has(action)) continue;
      const data = asTuple(tupleField(root, "data"));
      const address = principal(tupleField(data, "account"));
      if (!cohort.has(address)) continue;
      const aid = Number(asUint(tupleField(data, "asset-id")));
      const state = historical.get(address) ?? { collateral: new Map(), debt: new Map(), eventCount: 0 };
      state.eventCount += 1;
      // The feed is newest-first but does not carry block height. Preserve updates
      // until their transaction heights can be reconciled to the reference tip.
      if (data["updated-collateral-amount"]) {
        const updates = state.collateral.get(aid) ?? [];
        updates.push({ amount: asUint(data["updated-collateral-amount"]), transactionId: event.tx_id });
        state.collateral.set(aid, updates);
      }
      if (data["updated-scaled-debt"]) {
        const updates = state.debt.get(aid) ?? [];
        updates.push({ amount: asUint(data["updated-scaled-debt"]), transactionId: event.tx_id });
        state.debt.set(aid, updates);
      }
      historical.set(address, state);
    } catch {
      // Other print shapes remain outside this narrowly defined comparison.
    }
  }
  if (events.length < 50) break;
}

const enabledMask = asUint(await pinned.call(assets.contractPrincipal, "get-bitmap", []));
const transactionHeightCache = new Map<string, Promise<number>>();
async function transactionHeight(transactionId: string): Promise<number> {
  let pending = transactionHeightCache.get(transactionId);
  if (!pending) {
    pending = (async () => {
      const response = await fetchWithRateLimitRetry(fetch, `${baseUrl}/extended/v1/tx/${transactionId}`, {
        headers,
      }, 30_000);
      if (!response.ok) throw new Error(`Transaction ${transactionId} returned ${response.status}`);
      const body = await response.json() as { block_height?: number };
      if (!Number.isSafeInteger(body.block_height)) throw new Error(`Transaction ${transactionId} has no block height`);
      return body.block_height!;
    })();
    transactionHeightCache.set(transactionId, pending);
  }
  return pending;
}
async function stateAtTip(updates: Map<number, HistoryUpdate[]>): Promise<Map<number, bigint>> {
  const resolved = new Map<number, bigint>();
  for (const [assetId, candidates] of updates) {
    for (const candidate of candidates) {
      if (await transactionHeight(candidate.transactionId) <= pinned.blockHeight) {
        resolved.set(assetId, candidate.amount);
        break;
      }
    }
  }
  return resolved;
}
const rows: Array<Record<string, unknown>> = [];
for (const address of addresses) {
  const response = await pinned.call(marketVault.contractPrincipal, "get-position", [principalCV(address), uintCV(enabledMask)]);
  const error = responseErrorUint(response);
  const currentCollateral = new Map<number, bigint>();
  const currentDebt = new Map<number, bigint>();
  if (error === null) {
    const position = asTuple(unwrapOk(response));
    for (const item of asList(tupleField(position, "collateral"))) {
      const leg = asTuple(item);
      currentCollateral.set(Number(asUint(tupleField(leg, "aid"))), asUint(tupleField(leg, "amount")));
    }
    for (const item of asList(tupleField(position, "debt"))) {
      const leg = asTuple(item);
      currentDebt.set(Number(asUint(tupleField(leg, "aid"))), asUint(tupleField(leg, "scaled")));
    }
  }
  const history = historical.get(address);
  const historyCollateral = await stateAtTip(history?.collateral ?? new Map());
  const historyDebt = await stateAtTip(history?.debt ?? new Map());
  const expectedCollateral = [...historyCollateral].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a - b);
  const expectedDebt = [...historyDebt].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a - b);
  const actualCollateral = [...currentCollateral].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a - b);
  const actualDebt = [...currentDebt].filter(([, amount]) => amount > 0n).sort(([a], [b]) => a - b);
  const matched = JSON.stringify(expectedCollateral, (_, value) => typeof value === "bigint" ? value.toString() : value) ===
      JSON.stringify(actualCollateral, (_, value) => typeof value === "bigint" ? value.toString() : value) &&
    JSON.stringify(expectedDebt, (_, value) => typeof value === "bigint" ? value.toString() : value) ===
      JSON.stringify(actualDebt, (_, value) => typeof value === "bigint" ? value.toString() : value);
  rows.push({
    address,
    matched,
    historyEventCount: history?.eventCount ?? 0,
    eventDerived: { collateral: expectedCollateral, scaledDebt: expectedDebt },
    contractRead: { collateral: actualCollateral, scaledDebt: actualDebt },
  });
}

const matchedCount = rows.filter((row) => row.matched).length;
const artifact = {
  kind: "riskos-zest-independent-history-comparison",
  generatedAt: new Date().toISOString(),
  registryVersion: manifest.version,
  addressCount: rows.length,
  matchedCount,
  mismatchCount: rows.length - matchedCount,
  passed: matchedCount === rows.length,
  evidence: {
    historyPath: `${baseUrl}/extended/v1/contract/{contract}/events (full contract history)`,
    currentStatePath: `${stateBaseUrl}/v2/contracts/call-read/{contract}/get-position at pinned index block`,
    independence: stateBaseUrl === baseUrl
      ? "independent calculation methods on one provider"
      : "independent calculation methods on separate provider deployments",
    pinnedIndexBlockHash: pinned.indexBlockHash,
    pinnedBlockHeight: pinned.blockHeight,
    eventPages,
    contractEvents,
    note: stateBaseUrl === baseUrl
      ? "This validates decoder/history agreement. Set STACKS_REFERENCE_API_URL to a separately operated Stacks API/node for provider independence."
      : "History replay and pinned state reads used distinct configured provider deployments.",
  },
  results: rows,
};
const output = resolve(process.argv[3] ?? "artifacts/zest-history-100-comparison.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, addressCount: rows.length, matchedCount, mismatchCount: rows.length - matchedCount, eventPages, contractEvents }, null, 2));
if (!artifact.passed) process.exitCode = 1;
