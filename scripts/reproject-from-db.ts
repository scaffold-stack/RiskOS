import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import type { IngestedBlock, IngestedContractEvent, IngestedTransaction } from "../packages/data-foundation/src/chainhook.js";
import { projectProtocolEvents } from "../packages/data-foundation/src/protocol-projection.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-13.1.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
if (manifest.network !== network) throw new Error(`Registry ${manifest.version} is for ${manifest.network}, not ${network}`);

const sql = postgres(databaseUrl, { max: 4 });
const batchSize = Number(process.env.REPROJECT_BATCH_SIZE ?? 200);

const protocols = new Set(
  (process.env.REPROJECT_PROTOCOLS ?? "bitflow,sbtc")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const likePatterns: string[] = [];
if (protocols.has("bitflow")) likePatterns.push("%.dlmm-pool-%");
if (protocols.has("sbtc")) likePatterns.push("%.sbtc-registry");
if (protocols.has("zest")) likePatterns.push("%.v0-market-vault", "%.v0-8-market", "%.v0-vault-%");
if (likePatterns.length === 0) throw new Error("REPROJECT_PROTOCOLS produced no contract filters");

const blocks = await sql`
  SELECT DISTINCT e.index_block_hash, b.height, b.block_hash, b.parent_index_block_hash,
    b.burn_block_height, b.block_time
  FROM contract_events e
  JOIN chain_blocks b
    ON b.network = e.network AND b.index_block_hash = e.index_block_hash AND b.canonical
  WHERE e.network = ${network}
    AND e.canonical
    AND e.contract_identifier LIKE ANY(${likePatterns})
  ORDER BY b.height ASC
`;

let projected = 0;
let issues = 0;
let processed = 0;

for (let index = 0; index < blocks.length; index += batchSize) {
  const slice = blocks.slice(index, index + batchSize);
  for (const row of slice) {
    const indexBlockHash = String(row.index_block_hash);
    const txRows = await sql`
      SELECT t.tx_id, t.tx_index, t.success, t.raw
      FROM chain_transactions t
      WHERE t.network = ${network} AND t.index_block_hash = ${indexBlockHash} AND t.canonical
      ORDER BY t.tx_index ASC
    `;
    const eventRows = await sql`
      SELECT event_key, tx_id, event_index, contract_identifier, topic, event_type, value
      FROM contract_events
      WHERE network = ${network} AND index_block_hash = ${indexBlockHash} AND canonical
      ORDER BY tx_id, event_index ASC
    `;
    const eventsByTx = new Map<string, IngestedContractEvent[]>();
    for (const event of eventRows) {
      const txId = String(event.tx_id);
      const list = eventsByTx.get(txId) ?? [];
      list.push({
        eventKey: String(event.event_key),
        eventIndex: Number(event.event_index),
        eventType: String(event.event_type),
        contractIdentifier: event.contract_identifier == null ? null : String(event.contract_identifier),
        topic: event.topic == null ? null : String(event.topic),
        value: (event.value ?? {}) as Record<string, unknown>,
      });
      eventsByTx.set(txId, list);
    }
    const transactions: IngestedTransaction[] = txRows.map((tx) => ({
      txId: String(tx.tx_id),
      txIndex: Number(tx.tx_index),
      success: tx.success !== false,
      raw: (tx.raw ?? {}) as Record<string, unknown>,
      events: eventsByTx.get(String(tx.tx_id)) ?? [],
    }));
    // Include orphan event txs that somehow lack chain_transactions rows.
    for (const [txId, events] of eventsByTx) {
      if (transactions.some((tx) => tx.txId === txId)) continue;
      transactions.push({ txId, txIndex: 0, success: true, raw: {}, events });
    }
    const block: IngestedBlock = {
      indexBlockHash,
      blockHash: String(row.block_hash),
      height: Number(row.height),
      parentIndexBlockHash: String(row.parent_index_block_hash),
      burnBlockHeight: row.burn_block_height == null ? null : Number(row.burn_block_height),
      blockTime: row.block_time == null ? null : Number(row.block_time),
      transactions: transactions.sort((left, right) => left.txIndex - right.txIndex),
    };
    const result = projectProtocolEvents(network, block, manifest);
    for (const event of result.projections) {
      await sql`
        INSERT INTO protocol_projection_events ${sql({
          projection_id: event.projectionId,
          source_event_key: event.sourceEventKey,
          network: event.network,
          index_block_hash: event.indexBlockHash,
          block_height: event.blockHeight,
          tx_id: event.txId,
          event_index: event.eventIndex,
          protocol: event.protocol,
          adapter_version: event.adapterVersion,
          kind: event.kind,
          owner_address: event.ownerAddress,
          position_key: event.positionKey,
          payload: sql.json(event.payload as never),
          canonical: true,
        })}
        ON CONFLICT (projection_id) DO UPDATE SET canonical = true, payload = EXCLUDED.payload,
          owner_address = EXCLUDED.owner_address, position_key = EXCLUDED.position_key
      `;
    }
    for (const issue of result.issues) {
      await sql`
        INSERT INTO projection_issues (source_event_key, network, index_block_hash, protocol, code, detail, canonical)
        VALUES (${issue.sourceEventKey}, ${network}, ${indexBlockHash}, ${issue.protocol}, ${issue.code}, ${issue.detail}, true)
        ON CONFLICT (source_event_key, protocol, code, detail) DO UPDATE SET canonical = true
      `;
    }
    projected += result.projections.length;
    issues += result.issues.length;
    processed += 1;
  }
  console.error(JSON.stringify({ processed, totalBlocks: blocks.length, projected, issues }));
}

const counts = await sql`
  SELECT protocol, count(*)::integer AS count FROM protocol_projection_events
  WHERE network = ${network} AND canonical GROUP BY protocol ORDER BY protocol
`;
const issueCounts = await sql`
  SELECT protocol, code, count(*)::integer AS count FROM projection_issues
  WHERE network = ${network} AND canonical GROUP BY protocol, code ORDER BY protocol, code
`;
console.log(JSON.stringify({ network, registryVersion: manifest.version, processed, projected, issues, counts, issueCounts }, null, 2));
await sql.end();
