import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { parseChainhookPayload } from "../packages/data-foundation/src/chainhook.js";
import { PostgresDataFoundationStore } from "../packages/data-foundation/src/postgres-store.js";
import {
  compactChainhookBatch,
  projectionBackfillContracts,
} from "../packages/data-foundation/src/protocol-projection.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

type Json = Record<string, unknown>;
type Network = "mainnet" | "testnet";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const stacksUrl = (process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
const referenceUrl = (process.env.STACKS_REFERENCE_API_URL ?? "").replace(/\/$/, "");
const preferReference = process.env.BACKFILL_PREFER_REFERENCE === "1";
const stacksBases = preferReference
  ? [...new Set([referenceUrl, stacksUrl].filter(Boolean))]
  : [...new Set([stacksUrl, referenceUrl].filter(Boolean))];
if (stacksBases.length === 0) throw new Error("STACKS_API_URL or STACKS_REFERENCE_API_URL is required");
const network: Network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-13.1.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
if (manifest.network !== network) throw new Error(`Registry ${manifest.version} is for ${manifest.network}, not ${network}`);

const pageSize = integerEnv("BACKFILL_EVENT_PAGE_SIZE", 50, 1, 50);
const maxPagesPerContract = integerEnv("BACKFILL_MAX_PAGES_PER_CONTRACT", 100, 1, 50_000);
const concurrency = integerEnv("BACKFILL_HTTP_CONCURRENCY", 4, 1, 16);
const pagePrefetch = integerEnv("BACKFILL_PAGE_PREFETCH", 8, 1, 32);
const contractConcurrency = integerEnv("BACKFILL_CONTRACT_CONCURRENCY", 2, 1, 4);
const pageDelayMs = integerEnv("BACKFILL_PAGE_DELAY_MS", 0, 0, 5_000);
const untilExhausted = process.env.BACKFILL_UNTIL_EXHAUSTED === "1";
const maxDatabaseBytes = BigInt(process.env.BACKFILL_MAX_DATABASE_BYTES ?? "0");
if (maxDatabaseBytes < 0n) throw new Error("BACKFILL_MAX_DATABASE_BYTES must be zero or greater");
const selectedContracts = new Set(
  (process.env.BACKFILL_CONTRACTS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
);

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
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

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stacksHeaders(base: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "riskos/0.1-registry-backfill",
  };
  if (base.includes("hiro.so") && process.env.HIRO_API_KEY) headers["x-api-key"] = process.env.HIRO_API_KEY;
  if (base.includes("quiknode.pro") && process.env.STACKS_REFERENCE_API_KEY) {
    headers["x-api-key"] = process.env.STACKS_REFERENCE_API_KEY;
  }
  return headers;
}

async function stacksGet(path: string): Promise<Json> {
  const timeoutMs = integerEnv("BACKFILL_HTTP_TIMEOUT_MS", 90_000, 5_000, 180_000);
  const attempts = integerEnv("BACKFILL_HTTP_RETRIES", 8, 1, 16);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Prefer the primary base, but always cycle so a sticky Hiro tip-500 does not starve QuickNode.
    const base = stacksBases[(attempt - 1) % stacksBases.length]!;
    try {
      const response = await fetch(`${base}${path}`, {
        headers: stacksHeaders(base),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`${base} ${path} -> HTTP ${response.status}`);
      }
      if (!response.ok) throw new Error(`${base} ${path} -> HTTP ${response.status}`);
      return object(await response.json());
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const delay = /HTTP 429/.test(message)
        ? Math.min(60_000, 5_000 * attempt)
        : Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
      if (attempt < attempts) await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Stacks GET ${path} failed`);
}

/** @deprecated use stacksGet — kept as alias for call sites */
const hiro = stacksGet;

async function mapLimit<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        output[index] = await work(values[index]!);
      }
    }),
  );
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
    transactions: transactions
      .sort((a, b) => Number(a.tx_index ?? 0) - Number(b.tx_index ?? 0))
      .map(chainhookTransaction),
  };
}

const sql = postgres(databaseUrl, { max: 6 });
const store = new PostgresDataFoundationStore(sql);
const tipPayload = await hiro("/extended/v2/blocks?limit=1");
const tip = requiredHeight((tipPayload.results as Json[] | undefined)?.[0]?.height, "Stacks tip");
const projectionEntries = projectionBackfillContracts(manifest);
const entries = projectionEntries
  .filter((entry) => selectedContracts.size === 0 || selectedContracts.has(entry.contractPrincipal))
  .sort(
    (a, b) =>
      a.activationBlock - b.activationBlock || a.contractPrincipal.localeCompare(b.contractPrincipal),
  );
if (entries.length === 0) throw new Error("No projection-capable registry contracts matched BACKFILL_CONTRACTS");
console.error(JSON.stringify({
  stacksBases: stacksBases.map((base) => {
    try {
      return new URL(base).origin;
    } catch {
      return "[invalid-provider-url]";
    }
  }),
  preferReference,
  pagePrefetch,
  concurrency,
  maxPagesPerContract,
}));

const blockCache = new Map<number, Json>();
const txCache = new Map<string, Json>();
const needsFullTxReceipt = (contractPrincipal: string) => contractPrincipal.endsWith(".sbtc-registry");
const maxTxCache = integerEnv("BACKFILL_TX_CACHE_MAX", 5_000, 100, 100_000);
const maxBlockCache = integerEnv("BACKFILL_BLOCK_CACHE_MAX", 5_000, 100, 100_000);

function trimCache<K, V>(cache: Map<K, V>, maxSize: number) {
  if (cache.size <= maxSize) return;
  const excess = cache.size - Math.floor(maxSize * 0.8);
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}

function isProjectionRelevantEvent(contractPrincipal: string, event: Json): boolean {
  if (needsFullTxReceipt(contractPrincipal)) return true;
  const type = String(event.event_type ?? "").toLowerCase();
  if (type.includes("nft")) return true;
  if (contractPrincipal.includes(".dlmm-pool-")) {
    const repr = String(object(object(event.contract_log).value).repr ?? "");
    // DLMM pools emit high-volume swap prints; only mint/burn/ownership matter for projections.
    return /pool-mint|pool-burn|ownership/i.test(repr);
  }
  return type.includes("smart_contract_log") || type.includes("contract_log") || Boolean(event.contract_log);
}

async function loadKnownTransactions(txids: string[]): Promise<Map<string, Json>> {
  const found = new Map<string, Json>();
  if (txids.length === 0) return found;
  const rows = await sql`
    SELECT t.tx_id, t.tx_index, t.success, b.height AS block_height, b.index_block_hash,
      b.block_hash, b.parent_index_block_hash, b.burn_block_height, b.block_time
    FROM chain_transactions t
    JOIN chain_blocks b
      ON b.network = t.network AND b.index_block_hash = t.index_block_hash AND b.canonical
    WHERE t.network = ${network} AND t.canonical AND t.tx_id = ANY(${txids})
  `;
  for (const row of rows) {
    const height = Number(row.block_height);
    const block = {
      height,
      hash: String(row.block_hash),
      index_block_hash: String(row.index_block_hash),
      parent_index_block_hash: String(row.parent_index_block_hash),
      parent_block_hash: String(row.parent_index_block_hash),
      burn_block_height: row.burn_block_height == null ? null : Number(row.burn_block_height),
      block_time: row.block_time == null ? null : Number(row.block_time),
    };
    blockCache.set(height, block);
    found.set(String(row.tx_id), {
      tx_id: String(row.tx_id),
      tx_index: Number(row.tx_index),
      tx_status: row.success === false ? "abort_by_response" : "success",
      block_height: height,
      canonical: true,
      microblock_canonical: true,
      events: [],
      __fromDb: true,
      __block: block,
    });
  }
  return found;
}

async function cachedBlock(height: number): Promise<Json> {
  const existing = blockCache.get(height);
  if (existing) return existing;
  const block = await hiro(`/extended/v2/blocks/${height}`);
  blockCache.set(height, block);
  return block;
}

async function cachedTx(txid: string): Promise<Json> {
  const existing = txCache.get(txid);
  if (existing) return existing;
  const tx = await hiro(`/extended/v1/tx/${txid}`);
  txCache.set(txid, tx);
  return tx;
}

async function fetchTransactions(txids: string[]): Promise<void> {
  const missing = [...new Set(txids)].filter((txid) => !txCache.has(txid));
  if (missing.length === 0) return;
  const chunkSize = 20;
  const chunks: string[][] = [];
  for (let index = 0; index < missing.length; index += chunkSize) {
    chunks.push(missing.slice(index, index + chunkSize));
  }
  await mapLimit(chunks, concurrency, async (chunk) => {
    const query = chunk.map((txid) => `tx_id=${encodeURIComponent(txid)}`).join("&");
    try {
      const payload = await hiro(`/extended/v1/tx/multiple?${query}`);
      for (const [txid, entry] of Object.entries(payload)) {
        const row = object(entry);
        if (row.found === false) continue;
        const tx = object(row.result ?? entry);
        if (typeof tx.tx_id === "string") txCache.set(txid, tx);
        else if (typeof txid === "string" && txid.startsWith("0x")) txCache.set(txid, tx);
      }
      for (const txid of chunk) {
        if (!txCache.has(txid)) await cachedTx(txid);
      }
    } catch {
      await mapLimit(chunk, Math.min(concurrency, chunk.length), cachedTx);
    }
  });
}

async function fetchEventPage(contractPrincipal: string, pageOffset: number): Promise<Json[]> {
  const eventPage = await hiro(
    `/extended/v1/contract/${encodeURIComponent(contractPrincipal)}/events?limit=${pageSize}&offset=${pageOffset}`,
  );
  return Array.isArray(eventPage.results) ? eventPage.results.map(object) : [];
}

function synthesizeTransactions(events: Json[], known: Map<string, Json>): Json[] {
  const byTx = new Map<string, Json>();
  for (const event of events) {
    const txid = requiredText(event.tx_id, "contract-event tx id");
    const knownTx = known.get(txid) ?? txCache.get(txid);
    if (!knownTx) continue;
    const existing = byTx.get(txid) ?? {
      tx_id: txid,
      tx_index: Number(knownTx.tx_index ?? 0),
      tx_status: knownTx.tx_status ?? "success",
      block_height: knownTx.block_height,
      canonical: knownTx.canonical !== false,
      microblock_canonical: knownTx.microblock_canonical !== false,
      events: [] as Json[],
    };
    const eventsList = existing.events as Json[];
    eventsList.push({
      event_index: Number(event.event_index ?? eventsList.length),
      event_type: String(event.event_type ?? "smart_contract_log"),
      tx_id: txid,
      contract_log: object(event.contract_log),
      asset: event.asset,
      ...event,
    });
    existing.events = eventsList;
    byTx.set(txid, existing);
  }
  return [...byTx.values()];
}

const runSummary: Array<Record<string, unknown>> = [];
const failures: string[] = [];
let capacityReached = false;

async function pauseAtStorageCeiling(
  contractPrincipal: string,
  offset: number,
): Promise<boolean> {
  if (maxDatabaseBytes === 0n) return false;
  const [row] = await sql`SELECT pg_database_size(current_database()) AS size_bytes`;
  const sizeBytes = BigInt(String(row?.size_bytes ?? 0));
  if (sizeBytes < maxDatabaseBytes) return false;
  const detail =
    `Paused at database storage ceiling ${maxDatabaseBytes.toString()} bytes; ` +
    `current size ${sizeBytes.toString()} bytes; resume from offset ${offset}`;
  await sql`
    UPDATE registry_backfill_checkpoints
    SET status = 'paused', last_error = ${detail}, completed_at = NULL, updated_at = now()
    WHERE network = ${network} AND registry_version = ${manifest.version}
      AND contract_principal = ${contractPrincipal}
  `;
  capacityReached = true;
  runSummary.push({
    contract: contractPrincipal,
    status: "paused",
    next_offset: offset,
    detail,
  });
  return true;
}

async function backfillContract(entry: (typeof entries)[number]) {
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
    return;
  }

  let offset = Number(checkpoint?.next_offset ?? 0);
  let pages = 0;
  let eventsSeen = 0;
  let transactionsIngested = 0;
  await sql`
    UPDATE registry_backfill_checkpoints SET status = 'running', started_at = COALESCE(started_at, now()),
      last_error = NULL, completed_at = NULL, updated_at = now()
    WHERE network = ${network} AND registry_version = ${manifest.version}
      AND contract_principal = ${entry.contractPrincipal}
  `;

  try {
    while (pages < maxPagesPerContract) {
      if (await pauseAtStorageCeiling(entry.contractPrincipal, offset)) return;
      const windowSize = Math.min(pagePrefetch, maxPagesPerContract - pages);
      const pageOffsets = Array.from({ length: windowSize }, (_, index) => offset + index * pageSize);
      const fetched = await mapLimit(pageOffsets, Math.min(concurrency, pageOffsets.length), async (pageOffset) => {
        try {
          return {
            pageOffset,
            events: await fetchEventPage(entry.contractPrincipal, pageOffset),
            failed: false,
          };
        } catch (error) {
          // Never fail the whole window on a speculative future page; only the current offset is required.
          if (pageOffset === offset) throw error;
          return { pageOffset, events: [] as Json[], failed: true };
        }
      });
      fetched.sort((left, right) => left.pageOffset - right.pageOffset);

      for (const page of fetched) {
        if (page.pageOffset !== offset) break;
        if (page.failed) break;
        const events = page.events;
        if (events.length === 0) {
          await sql`
            UPDATE registry_backfill_checkpoints SET status = 'complete', completed_at = now(),
              last_error = NULL, updated_at = now()
            WHERE network = ${network} AND registry_version = ${manifest.version}
              AND contract_principal = ${entry.contractPrincipal}
          `;
          runSummary.push({
            contract: entry.contractPrincipal,
            activationBlock: entry.activationBlock,
            pages,
            eventsSeen,
            transactionsIngested,
            status: "complete",
            next_offset: offset,
          });
          return;
        }

        const relevantEvents = events.filter((event) => isProjectionRelevantEvent(entry.contractPrincipal, event));
        const txids = [...new Set(relevantEvents.map((event) => requiredText(event.tx_id, "contract-event tx id")))];
        const known = await loadKnownTransactions(txids);
        const useSynthetic = !needsFullTxReceipt(entry.contractPrincipal);
        if (useSynthetic) {
          for (const [txid, tx] of known) txCache.set(txid, tx);
        } else {
          // Full-receipt contracts need Hiro event payloads; DB stubs only seed block metadata.
          for (const tx of known.values()) {
            const height = requiredHeight(tx.block_height, "transaction block height");
            if (tx.__block) blockCache.set(height, tx.__block as Json);
          }
        }
        await fetchTransactions(txids.filter((txid) => !txCache.has(txid)));

        const transactions = useSynthetic
          ? synthesizeTransactions(relevantEvents, new Map([...txCache].map(([id, tx]) => [id, tx])))
          : txids.map((txid) => txCache.get(txid)!).filter(Boolean);

        const eligible = transactions.filter(
          (tx) =>
            requiredHeight(tx.block_height, "transaction block height") >= entry.activationBlock &&
            tx.canonical !== false &&
            tx.microblock_canonical !== false,
        );
        const byHeight = new Map<number, Json[]>();
        for (const tx of eligible) {
          const height = requiredHeight(tx.block_height, "transaction block height");
          byHeight.set(height, [...(byHeight.get(height) ?? []), tx]);
        }
        for (const [height, blockTransactions] of [...byHeight.entries()].sort(([a], [b]) => a - b)) {
          const block = (blockTransactions[0] as { __block?: Json } | undefined)?.__block ?? (await cachedBlock(height));
          const payload = {
            chainhook: { uuid: `registry-backfill-${manifest.version}` },
            rollback: [],
            apply: [chainhookBlock(block, blockTransactions)],
          };
          const parsedBatch = parseChainhookPayload(payload, {
            network,
            source: `hiro-contract-backfill:${entry.contractPrincipal}`,
          });
          const batch = compactChainhookBatch(parsedBatch, manifest);
          await store.ingest(batch, manifest);
        }

        pages += 1;
        eventsSeen += events.length;
        transactionsIngested += eligible.length;
        offset += events.length;
        const exhausted = events.length < pageSize;
        await sql`
          UPDATE registry_backfill_checkpoints SET
            next_offset = ${offset}, pages_completed = pages_completed + 1,
            events_seen = events_seen + ${events.length},
            transactions_ingested = transactions_ingested + ${eligible.length},
            status = ${exhausted ? "complete" : "running"},
            completed_at = ${exhausted ? new Date() : null},
            last_error = NULL,
            updated_at = now()
          WHERE network = ${network} AND registry_version = ${manifest.version}
            AND contract_principal = ${entry.contractPrincipal}
        `;
        if (exhausted) {
          runSummary.push({
            contract: entry.contractPrincipal,
            activationBlock: entry.activationBlock,
            pages,
            eventsSeen,
            transactionsIngested,
            status: "complete",
            next_offset: offset,
          });
          return;
        }
        if (pages % 50 === 0) {
          trimCache(txCache, maxTxCache);
          trimCache(blockCache, maxBlockCache);
          console.error(
            JSON.stringify({
              contract: entry.contractPrincipal.split(".")[1],
              pages,
              offset,
              eventsSeen,
              relevant: relevantEvents.length,
              dbHits: known.size,
              txCache: txCache.size,
              blockCache: blockCache.size,
            }),
          );
        }
        if (pageDelayMs > 0) await sleep(pageDelayMs);
        if (pages >= maxPagesPerContract) break;
      }
    }

    const pausedDetail = `Paused after BACKFILL_MAX_PAGES_PER_CONTRACT=${maxPagesPerContract}; resume from offset ${offset}`;
    await sql`
      UPDATE registry_backfill_checkpoints SET status = 'paused', last_error = ${pausedDetail},
        completed_at = NULL, updated_at = now()
      WHERE network = ${network} AND registry_version = ${manifest.version}
        AND contract_principal = ${entry.contractPrincipal}
    `;
    runSummary.push({
      contract: entry.contractPrincipal,
      activationBlock: entry.activationBlock,
      pages,
      eventsSeen,
      transactionsIngested,
      status: "paused",
      next_offset: offset,
      detail: pausedDetail,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown backfill error";
    await sql`
      UPDATE registry_backfill_checkpoints SET status = 'failed', last_error = ${detail}, updated_at = now()
      WHERE network = ${network} AND registry_version = ${manifest.version}
        AND contract_principal = ${entry.contractPrincipal}
    `;
    runSummary.push({ contract: entry.contractPrincipal, status: "failed", error: detail });
    failures.push(`${entry.contractPrincipal}: ${detail}`);
  }
}

try {
  for (const entry of entries) {
    await sql`
      INSERT INTO registry_backfill_checkpoints (
        network, registry_version, contract_principal, activation_block, observed_tip
      ) VALUES (${network}, ${manifest.version}, ${entry.contractPrincipal}, ${entry.activationBlock}, ${tip})
      ON CONFLICT (network, registry_version, contract_principal) DO UPDATE SET
        observed_tip = EXCLUDED.observed_tip, updated_at = now()
    `;
  }

  let pass = 0;
  do {
    pass += 1;
    runSummary.length = 0;
    failures.length = 0;
    const ordered = [...entries].sort((left, right) => {
      // Prefer contracts already near exhaustion so production can clear the easy set first.
      return left.contractPrincipal.localeCompare(right.contractPrincipal);
    });
    const statuses = await sql`
      SELECT contract_principal, status, next_offset
      FROM registry_backfill_checkpoints
      WHERE network = ${network} AND registry_version = ${manifest.version}
        AND contract_principal = ANY(${entries.map((entry) => entry.contractPrincipal)})
    `;
    const statusByContract = new Map(
      statuses.map((row) => [
        String(row.contract_principal),
        { status: String(row.status), nextOffset: Number(row.next_offset) },
      ]),
    );
    ordered.sort((left, right) => {
      const leftStatus = statusByContract.get(left.contractPrincipal);
      const rightStatus = statusByContract.get(right.contractPrincipal);
      const leftDone = leftStatus?.status === "complete" ? 1 : 0;
      const rightDone = rightStatus?.status === "complete" ? 1 : 0;
      if (leftDone !== rightDone) return leftDone - rightDone;
      return (leftStatus?.nextOffset ?? 0) - (rightStatus?.nextOffset ?? 0);
    });
    const incompleteEntries = ordered.filter((entry) => statusByContract.get(entry.contractPrincipal)?.status !== "complete");
    await mapLimit(incompleteEntries, contractConcurrency, backfillContract);
    const incomplete = await sql`
      SELECT contract_principal, status, next_offset
      FROM registry_backfill_checkpoints
      WHERE network = ${network} AND registry_version = ${manifest.version}
        AND contract_principal = ANY(${entries.map((entry) => entry.contractPrincipal)})
        AND status <> 'complete'
      ORDER BY contract_principal
    `;
    if (!untilExhausted || incomplete.length === 0 || capacityReached) {
      const projectionCounts = await sql`
        SELECT protocol, count(*)::integer AS count FROM protocol_projection_events
        WHERE network = ${network} AND canonical GROUP BY protocol ORDER BY protocol
      `;
      const issues = await sql`
        SELECT protocol, code, count(*)::integer AS count FROM projection_issues
        WHERE network = ${network} AND canonical GROUP BY protocol, code ORDER BY protocol, code
      `;
      console.log(
        JSON.stringify(
          {
            network,
            registryVersion: manifest.version,
            observedTip: tip,
            pass,
            untilExhausted,
            projectionContractCount: entries.length,
            incomplete,
            contracts: runSummary,
            projectionCounts,
            issues,
            failures,
            capacityReached,
          },
          null,
          2,
        ),
      );
      if (failures.length > 0 || incomplete.length > 0) process.exitCode = 1;
      break;
    }
    if (failures.length > 0) {
      console.error(
        JSON.stringify({
          pass,
          remaining: incomplete.length,
          failures,
          message: "Retrying remaining contracts after transient failures",
        }),
      );
      await sleep(Math.min(120_000, 15_000 * pass));
    } else {
      console.error(
        JSON.stringify({
          pass,
          remaining: incomplete.length,
          message: "Continuing until every projection contract is exhausted",
        }),
      );
    }
  } while (untilExhausted);
} finally {
  await sql.end({ timeout: 5 });
}
