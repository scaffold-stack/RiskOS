/**
 * Records canonical portfolio observations through the protected operations API.
 * The API only persists positions pinned to its current canonical Chainhook tip;
 * this process never manufactures timestamps, blocks, prices, or missing positions.
 *
 * Usage:
 *   PORTFOLIO_OBSERVER_ADDRESSES=SP...,SP... npm run observe:portfolios
 *   npm run observe:portfolios -- --once SP...
 */

const apiUrl = (process.env.RISKOS_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const token = process.env.OPERATIONS_BEARER_TOKEN;
const once = process.argv.includes("--once");
const cliAddresses = process.argv.slice(2).filter((item) => item !== "--once");
const configuredAddresses = (process.env.PORTFOLIO_OBSERVER_ADDRESSES ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const addresses = [...new Set([...configuredAddresses, ...cliAddresses])];
const intervalSeconds = Number(process.env.PORTFOLIO_OBSERVER_INTERVAL_SECONDS ?? 300);

if (!token) throw new Error("OPERATIONS_BEARER_TOKEN is required");
if (addresses.length === 0) throw new Error("Set PORTFOLIO_OBSERVER_ADDRESSES or pass at least one address");
if (!addresses.every((address) => /^(SP|SM)[0-9A-Z]{38,40}$/.test(address))) {
  throw new Error("Every observer address must be a Stacks mainnet principal");
}
if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 30) {
  throw new Error("PORTFOLIO_OBSERVER_INTERVAL_SECONDS must be an integer of at least 30");
}

async function observe(address: string) {
  const response = await fetch(`${apiUrl}/v1/operations/snapshots/${encodeURIComponent(address)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${response.status} ${String(body.detail ?? body.title ?? "snapshot failed")}`);
  }
  console.log(JSON.stringify({
    address,
    blockHeight: body.blockHeight,
    indexBlockHash: body.indexBlockHash,
    persisted: body.persisted,
    skippedCount: Array.isArray(body.skipped) ? body.skipped.length : 0,
  }));
}

async function run() {
  const results = await Promise.allSettled(addresses.map(observe));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(JSON.stringify({ address: addresses[index], error: String(result.reason) }));
    }
  });
  if (results.every((result) => result.status === "rejected")) process.exitCode = 1;
}

await run();
if (!once) {
  setInterval(() => void run(), intervalSeconds * 1_000);
}
