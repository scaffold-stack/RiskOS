import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitflowMainnetAdapter, StacksApiAdapter, StacksReadOnlyClient, ZestMainnetAdapter } from "../packages/adapters/src/index.js";
import {
  CallbackPositionSource,
  RiskOsHttpPositionSource,
  runAddressComparisonGate,
} from "../packages/data-foundation/src/address-comparison.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";
import { DiaOraclePriceBook, enrichPositionsWithUsd, ZestVaultExchangeRatePriceBook } from "../packages/pricing/src/index.js";

const inputPath = process.argv[2] ?? "fixtures/mainnet-100-addresses.json";
const outputPath = process.argv[3] ?? "artifacts/mainnet-100-address-comparison.json";
const mode = process.env.RISKOS_GATE_MODE ?? (process.env.RISKOS_REFERENCE_URL ? "http" : "local-adapters");
const candidateUrl = process.env.RISKOS_CANDIDATE_URL;
const referenceUrl = process.env.RISKOS_REFERENCE_URL;

const addresses = JSON.parse(await readFile(resolve(inputPath), "utf8")) as string[];

async function adapterDiscover() {
  const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-04.2.signed.json";
  const payload = JSON.parse(await readFile(resolve(signedPath), "utf8"));
  const manifest = unwrapRegistryPayload(payload).manifest;
  const stacksUrl = process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so";
  const client = new StacksReadOnlyClient(stacksUrl, fetch, process.env.HIRO_API_KEY);
  const provider = async () => manifest;
  const adapters = [
    new StacksApiAdapter(stacksUrl, fetch, process.env.HIRO_API_KEY, async () =>
      manifest.entries.flatMap((entry) => entry.assetDefinitions)),
    new ZestMainnetAdapter(provider, client),
    new BitflowMainnetAdapter(
      provider,
      process.env.BITFLOW_APP_API_URL ?? "https://bff.bitflowapis.finance/api/app",
      process.env.BITFLOW_QUOTES_API_URL ?? "https://bff.bitflowapis.finance/api/quotes",
      fetch,
      stacksUrl,
      process.env.HIRO_API_KEY,
    ),
  ];
  const priceBook = new ZestVaultExchangeRatePriceBook(new DiaOraclePriceBook(client), client, provider);
  return async (address: string) => {
    const settled = await Promise.allSettled(adapters.map((adapter) => adapter.discover(address)));
    const positions = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const enriched = await enrichPositionsWithUsd(positions, priceBook);
    return enriched.positions;
  };
}

let candidate;
let reference;
let independence: string;

if (mode === "http") {
  if (!candidateUrl || !referenceUrl) {
    throw new Error("HTTP gate requires RISKOS_CANDIDATE_URL and RISKOS_REFERENCE_URL");
  }
  if (candidateUrl.replace(/\/$/, "") === referenceUrl.replace(/\/$/, "")) {
    throw new Error("The candidate and independent reference URLs must be different deployments");
  }
  candidate = new RiskOsHttpPositionSource(candidateUrl);
  reference = new RiskOsHttpPositionSource(referenceUrl);
  independence = "separate-http-deployments";
} else if (mode === "api-vs-adapters") {
  if (!candidateUrl) throw new Error("api-vs-adapters mode requires RISKOS_CANDIDATE_URL");
  candidate = new RiskOsHttpPositionSource(candidateUrl);
  reference = new CallbackPositionSource(await adapterDiscover());
  independence = "http-api-vs-direct-adapters";
} else {
  const discover = await adapterDiscover();
  const cache = new Map<string, Awaited<ReturnType<typeof discover>>>();
  const once = async (address: string) => {
    if (!cache.has(address)) cache.set(address, await discover(address));
    return cache.get(address)!;
  };
  candidate = new CallbackPositionSource(once);
  reference = new CallbackPositionSource(async (address) => structuredClone(await once(address)));
  independence = "local-adapter-self-consistency";
}

const run = await runAddressComparisonGate(addresses, candidate, reference);
const artifact = {
  runId: run.runId,
  addressCount: run.addressCount,
  matchedCount: run.matchedCount,
  mismatchCount: run.mismatchCount,
  passed: run.passed,
  meta: {
    mode,
    independence,
    inputPath: resolve(inputPath),
    generatedAt: new Date().toISOString(),
    note: independence === "separate-http-deployments"
      ? "Grant-grade: two independently deployed position calculators."
      : "Engineering gate artifact. Replace with separate-http-deployments before public beta claim.",
  },
  results: run.results.map((result) => ({
    address: result.address,
    matched: result.matched,
    candidateDigest: result.candidateDigest,
    referenceDigest: result.referenceDigest,
    candidatePositionCount: result.candidate.length,
    referencePositionCount: result.reference.length,
  })),
};
const resolvedOutput = resolve(outputPath);
await mkdir(dirname(resolvedOutput), { recursive: true });
await writeFile(resolvedOutput, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  runId: run.runId,
  addressCount: run.addressCount,
  matchedCount: run.matchedCount,
  mismatchCount: run.mismatchCount,
  passed: run.passed,
  mode,
  independence,
  output: resolvedOutput,
}, null, 2));
if (!run.passed) process.exitCode = 1;
