import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { parseChainhookPayload } from "../packages/data-foundation/src/chainhook.js";
import { PostgresDataFoundationStore } from "../packages/data-foundation/src/postgres-store.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

/**
 * Backfill canonical Stacks blocks into the data foundation from Hiro v2 APIs.
 * Converts each height into a Chainhook-shaped apply payload and ingests it.
 *
 * Usage:
 *   DATABASE_URL=... npm run backfill:chainhook -- [fromHeight] [toHeight]
 * Defaults: registry min activationBlock → tip (capped by BACKFILL_MAX_BLOCKS, default 50).
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const stacksUrl = (process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
const network = (process.env.NETWORK === "testnet" ? "testnet" : "mainnet") as "mainnet" | "testnet";
const maxBlocks = Number(process.env.BACKFILL_MAX_BLOCKS ?? 50);
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-04.2.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
const minActivation = Math.min(...manifest.entries.filter((entry) => entry.enabled).map((entry) => entry.activationBlock));

async function hiro(path: string) {
  const response = await fetch(`${stacksUrl}${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "riskos/0.1-backfill",
      ...(process.env.HIRO_API_KEY ? { "x-api-key": process.env.HIRO_API_KEY } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Hiro ${path} → HTTP ${response.status}`);
  return response.json();
}

const tip = await hiro("/extended/v2/blocks?limit=1") as { results: Array<{ height: number }> };
const tipHeight = tip.results[0]?.height;
if (!tipHeight) throw new Error("Unable to resolve Stacks tip height");

const fromHeight = Number(process.argv[2] ?? Math.max(minActivation, tipHeight - maxBlocks + 1));
const toHeight = Number(process.argv[3] ?? tipHeight);
if (!Number.isSafeInteger(fromHeight) || !Number.isSafeInteger(toHeight) || toHeight < fromHeight) {
  throw new Error("Invalid height range");
}
if (toHeight - fromHeight + 1 > maxBlocks) {
  throw new Error(`Range exceeds BACKFILL_MAX_BLOCKS=${maxBlocks}; narrow the window or raise the cap`);
}

const sql = postgres(databaseUrl, { max: 4 });
const store = new PostgresDataFoundationStore(sql);
const summary = { fromHeight, toHeight, ingested: 0, skipped: 0, failed: [] as Array<{ height: number; error: string }> };

try {
  for (let height = fromHeight; height <= toHeight; height += 1) {
    try {
      const block = await hiro(`/extended/v2/blocks/${height}`) as Record<string, unknown>;
      const txs = await hiro(`/extended/v1/tx/block_height/${height}?limit=50`) as { results?: unknown[] };
      const payload = {
        chainhook: { uuid: `backfill-${network}-${height}` },
        rollback: [],
        apply: [{
          block_identifier: { index: height, hash: String(block.hash ?? block.index_block_hash) },
          parent_block_identifier: block.parent_block_id
            ? { index: height - 1, hash: String(block.parent_block_id) }
            : { index: Math.max(0, height - 1), hash: String(block.parent_index_block_hash ?? "0x00") },
          metadata: {
            index_block_hash: block.index_block_hash,
            burn_block_height: block.burn_block_height,
            block_time: block.block_time,
          },
          transactions: (txs.results ?? []).map((tx, txIndex) => {
            const row = tx as Record<string, unknown>;
            const receipt = (row.event_count ? row : row) as Record<string, unknown>;
            return {
              transaction_identifier: { hash: String(row.tx_id ?? row.txid ?? `unknown-${height}-${txIndex}`) },
              metadata: {
                success: row.tx_status === "success" || row.canonical === true || row.success === true,
                receipt: { events: Array.isArray(row.events) ? row.events : [] },
                ...(typeof receipt.description === "string" ? { description: receipt.description } : {}),
              },
            };
          }),
        }],
      };
      const batch = parseChainhookPayload(payload, {
        network,
        deliveryId: `backfill-${network}-${height}-${String(block.index_block_hash)}`,
        source: "hiro-backfill",
      });
      const result = await store.ingest(batch, manifest);
      if (result.duplicate) summary.skipped += 1;
      else summary.ingested += 1;
      console.log(JSON.stringify({ height, duplicate: result.duplicate, tip: await store.canonicalTip(network) }));
    } catch (error) {
      summary.failed.push({ height, error: error instanceof Error ? error.message : "unknown" });
      console.error(JSON.stringify({ height, error: summary.failed.at(-1)?.error }));
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}

console.log(JSON.stringify({ summary, minActivation, tipHeight }, null, 2));
if (summary.failed.length > 0) process.exitCode = 1;
