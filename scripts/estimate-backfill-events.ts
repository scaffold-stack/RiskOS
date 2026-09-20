/**
 * Estimates remaining Hiro contract-event volume for projection backfill contracts.
 * Usage: npm run backfill:estimate
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { projectionBackfillContracts } from "../packages/data-foundation/src/protocol-projection.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

const stacksUrl = (process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-13.1.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
const databaseUrl = process.env.DATABASE_URL;

async function hiro(path: string) {
  const attempts = 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${stacksUrl}${path}`, {
        headers: {
          accept: "application/json",
          "user-agent": "riskos/0.1-backfill-estimate",
          ...(process.env.HIRO_API_KEY ? { "x-api-key": process.env.HIRO_API_KEY } : {}),
        },
        signal: AbortSignal.timeout(45_000),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Hiro ${path} -> HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(`Hiro ${path} -> HTTP ${response.status}`);
      return response.json() as Promise<{ results?: unknown[] }>;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Hiro ${path} failed`);
}

async function eventCount(contract: string): Promise<number | null> {
  let lo = 0;
  let probe = 50;
  let hi = 0;
  while (probe < 5_000_000) {
    try {
      const page = await hiro(`/extended/v1/contract/${encodeURIComponent(contract)}/events?limit=1&offset=${probe}`);
      if (!page.results?.length) {
        hi = probe;
        break;
      }
      lo = probe;
      probe *= 2;
    } catch {
      // Hiro often 500s on very large offsets; treat as unknown upper bound.
      return null;
    }
  }
  if (hi === 0) return null;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const page = await hiro(`/extended/v1/contract/${encodeURIComponent(contract)}/events?limit=1&offset=${mid}`);
      if (page.results?.length) lo = mid;
      else hi = mid;
    } catch {
      hi = mid;
    }
  }
  return hi;
}

const checkpoints = new Map<string, { status: string; next_offset: number; events_seen: number }>();
if (databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql`
      SELECT contract_principal, status, next_offset, events_seen
      FROM registry_backfill_checkpoints
      WHERE network = ${manifest.network} AND registry_version = ${manifest.version}
    `;
    for (const row of rows) {
      checkpoints.set(String(row.contract_principal), {
        status: String(row.status),
        next_offset: Number(row.next_offset),
        events_seen: Number(row.events_seen),
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const rows = [];
for (const entry of projectionBackfillContracts(manifest)) {
  const total = await eventCount(entry.contractPrincipal);
  const checkpoint = checkpoints.get(entry.contractPrincipal);
  const offset = checkpoint?.next_offset ?? 0;
  rows.push({
    contract: entry.contractPrincipal,
    status: checkpoint?.status ?? "missing",
    eventsApprox: total,
    nextOffset: offset,
    remainingApprox: total == null ? null : Math.max(0, total - offset),
  });
}
console.log(JSON.stringify({ registryVersion: manifest.version, contracts: rows }, null, 2));
