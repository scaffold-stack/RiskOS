import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { parseChainhookPayload } from "../packages/data-foundation/src/chainhook.js";
import { PostgresDataFoundationStore } from "../packages/data-foundation/src/postgres-store.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

type Json = Record<string, unknown>;
type Network = "mainnet" | "testnet";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const stacksUrl = (process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
const network: Network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-04.2.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
if (manifest.network !== network) throw new Error(`Registry ${manifest.version} is for ${manifest.network}, not ${network}`);

const pageSize = integerEnv("BACKFILL_EVENT_PAGE_SIZE", 50, 1, 50);
const maxPagesPerContract = integerEnv("BACKFILL_MAX_PAGES_PER_CONTRACT", 10, 1, 10_000);
const concurrency = integerEnv("BACKFILL_HTTP_CONCURRENCY", 4, 1, 10);
const selectedContracts = new Set((process.env.BACKFILL_CONTRACTS ?? "").split(",").map((value) => value.trim()).filter(Boolean));

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${label}`);
  return value;
}

function requiredHeight(value: unknown, label: string): number {
  const height = Number(value);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`Invalid ${label}`);
  return height;
}

async function hiro(path: string): Promise<Json> {
  const response = await fetch(`${stacksUrl}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "riskos/0.1-registry-backfill",
      ...(process.env.HIRO_API_KEY ? { "x-api-key": process.env.HIRO_API_KEY } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Hiro ${path} -> HTTP ${response.status}`);
  return object(await response.json());
}

async function mapLimit<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await work(values[index]!);
    }
  }));
  return output;
}

function chainhookTransaction(tx: Json) {
  return {
    transaction_identifier: { hash: requiredText(tx.tx_id, "transaction id") },
    metadata: {
      position: Number(tx.tx_index ?? 0),
      success: tx.tx_status === "success",
      receipt: { events: Array.isArray(tx.events) ? tx.events : [] },
    },
  };
}

function chainhookBlock(block: Json, transactions: Json[]) {
  const height = requiredHeight(block.height, "block height");
  return {
    block_identifier: { index: height, hash: requiredText(block.hash, "block hash") },
    parent_block_identifier: {
      index: Math.max(0, height - 1),
      hash: requiredText(block.parent_block_hash ?? block.parent_index_block_hash, "parent block hash"),
    },
    timestamp: block.block_time,
    metadata: {
      index_block_hash: requiredText(block.index_block_hash, "index block hash"),
      parent_index_block_hash: block.parent_index_block_hash,
      burn_block_height: block.burn_block_height,
      block_time: block.block_time,
    },
    transactions: transactions.sort((a, b) => Number(a.tx_index ?? 0) - Number(b.tx_index ?? 0)).map(chainhookTransaction),
  };
}

const sql = postgres(databaseUrl, { max: 6 });
const store = new PostgresDataFoundationStore(sql);
const tipPayload = await hiro("/extended/v2/blocks?limit=1");
const tip = requiredHeight((tipPayload.results as Json[] | undefined)?.[0]?.height, "Stacks tip");
const entries = manifest.entries
  .filter((entry) => entry.enabled && (selectedContracts.size === 0 || selectedContracts.has(entry.contractPrincipal)))
  .sort((a, b) => a.activationBlock - b.activationBlock || a.contractPrincipal.localeCompare(b.contractPrincipal));
if (entries.length === 0) throw new Error("No enabled registry contracts matched BACKFILL_CONTRACTS");

const runSummary: Array<Record<string, unknown>> = [];
try {
  for (const entry of entries) {
    await sql`
      INSERT INTO registry_backfill_checkpoints (
        network, registry_version, contract_principal, activation_block, observed_tip
      ) VALUES (${network}, ${manifest.version}, ${entry.contractPrincipal}, ${entry.activationBlock}, ${tip})
      ON CONFLICT (network, registry_version, contract_principal) DO UPDATE SET
        observed_tip = EXCLUDED.observed_tip, updated_at = now()
    `;
    const [checkpoint] = await sql`
      SELECT next_offset, status FROM registry_backfill_checkpoints
      WHERE network = ${network} AND registry_version = ${manifest.version}
        AND contract_principal = ${entry.contractPrincipal}
    `;
    if (checkpoint?.status === "complete") {
      runSummary.push({ contract: entry.contractPrincipal, status: "already-complete" });
      continue;
    }
    let offset = Number(checkpoint?.next_offset ?? 0);
    let pages = 0;
    let eventsSeen = 0;
    let transactionsIngested = 0;
    await sql`
      UPDATE registry_backfill_checkpoints SET status = 'running', started_at = COALESCE(started_at, now()),
        last_error = NULL, updated_at = now()
      WHERE network = ${network} AND registry_version = ${manifest.version}
        AND contract_principal = ${entry.contractPrincipal}
    `;
    try {
      while (pages < maxPagesPerContract) {
        const eventPage = await hiro(`/extended/v1/contract/${encodeURIComponent(entry.contractPrincipal)}/events?limit=${pageSize}&offset=${offset}`);
        const events = Array.isArray(eventPage.results) ? eventPage.results.map(object) : [];
        if (events.length === 0) {
          await sql`
            UPDATE registry_backfill_checkpoints SET status = 'complete', completed_at = now(), updated_at = now()
            WHERE network = ${network} AND registry_version = ${manifest.version}
              AND contract_principal = ${entry.contractPrincipal}
          `;
          break;
        }
        const txids = [...new Set(events.map((event) => requiredText(event.tx_id, "contract-event tx id")))];
        const transactions = await mapLimit(txids, concurrency, (txid) => hiro(`/extended/v1/tx/${txid}`));
        const eligible = transactions.filter((tx) => requiredHeight(tx.block_height, "transaction block height") >= entry.activationBlock && tx.canonical !== false && tx.microblock_canonical !== false);
        const byHeight = new Map<number, Json[]>();
        for (const tx of eligible) {
          const height = requiredHeight(tx.block_height, "transaction block height");
          byHeight.set(height, [...(byHeight.get(height) ?? []), tx]);
        }
        for (const [height, blockTransactions] of [...byHeight.entries()].sort(([a], [b]) => a - b)) {
          const block = await hiro(`/extended/v2/blocks/${height}`);
          const payload = { chainhook: { uuid: `registry-backfill-${manifest.version}` }, rollback: [], apply: [chainhookBlock(block, blockTransactions)] };
          const batch = parseChainhookPayload(payload, {
            network,
            source: `hiro-contract-backfill:${entry.contractPrincipal}`,
            deliveryId: `${manifest.version}:${offset}:${height}:${String(block.index_block_hash)}`,
          });
          await store.ingest(batch, manifest);
        }
        pages += 1;
        eventsSeen += events.length;
        transactionsIngested += eligible.length;
        offset += events.length;
        const complete = events.length < pageSize;
        await sql`
          UPDATE registry_backfill_checkpoints SET
            next_offset = ${offset}, pages_completed = pages_completed + 1,
            events_seen = events_seen + ${events.length}, transactions_ingested = transactions_ingested + ${eligible.length},
            status = ${complete ? "complete" : "running"}, completed_at = ${complete ? new Date() : null}, updated_at = now()
          WHERE network = ${network} AND registry_version = ${manifest.version}
            AND contract_principal = ${entry.contractPrincipal}
        `;
        if (complete) break;
      }
      const [state] = await sql`
        SELECT status, next_offset, pages_completed, events_seen, transactions_ingested
        FROM registry_backfill_checkpoints WHERE network = ${network} AND registry_version = ${manifest.version}
          AND contract_principal = ${entry.contractPrincipal}
      `;
      runSummary.push({ contract: entry.contractPrincipal, activationBlock: entry.activationBlock, pages, eventsSeen, transactionsIngested, ...state });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown backfill error";
      await sql`
        UPDATE registry_backfill_checkpoints SET status = 'failed', last_error = ${detail}, updated_at = now()
        WHERE network = ${network} AND registry_version = ${manifest.version}
          AND contract_principal = ${entry.contractPrincipal}
      `;
      runSummary.push({ contract: entry.contractPrincipal, status: "failed", error: detail });
      throw error;
    }
  }
  const projectionCounts = await sql`
    SELECT protocol, count(*)::integer AS count FROM protocol_projection_events
    WHERE network = ${network} AND canonical GROUP BY protocol ORDER BY protocol
  `;
  const issues = await sql`
    SELECT protocol, code, count(*)::integer AS count FROM projection_issues
    WHERE network = ${network} AND canonical GROUP BY protocol, code ORDER BY protocol, code
  `;
  console.log(JSON.stringify({ network, registryVersion: manifest.version, observedTip: tip, contracts: runSummary, projectionCounts, issues }, null, 2));
} finally {
  await sql.end({ timeout: 5 });
}
