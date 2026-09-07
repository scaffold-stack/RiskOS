import postgres from "postgres";
import { createHash } from "node:crypto";
import { positionSchema } from "../../domain/src/index.js";
import type { ChainhookBatch, IngestedBlock } from "./chainhook.js";
import { canonicalJson } from "./canonical-json.js";
import { projectProtocolEvents, type ProtocolProjection } from "./protocol-projection.js";
import type { RegistryManifest } from "./registry.js";
import type { CanonicalBlock, DataFoundationStore, IngestionResult, PositionSnapshotBatch, StoredPositionSnapshot } from "./store.js";

type Sql = ReturnType<typeof postgres>;

export class PostgresDataFoundationStore implements DataFoundationStore {
  constructor(private readonly sql: Sql) {}

  async ingest(batch: ChainhookBatch, manifest: RegistryManifest | null = null): Promise<IngestionResult> {
    return this.sql.begin(async (tx) => {
      const inserted = await tx`
        INSERT INTO raw_chain_events ${tx({
          event_key: batch.eventKey,
          source: batch.source,
          network: batch.network,
          payload_sha256: batch.payloadSha256,
          payload: tx.json(batch.payload as never),
          status: "received",
        })}
        ON CONFLICT (event_key) DO NOTHING
        RETURNING event_key
      `;
      if (inserted.length === 0) {
        const existing = await tx`SELECT payload_sha256 FROM raw_chain_events WHERE event_key = ${batch.eventKey}`;
        if (String(existing[0]?.payload_sha256) !== batch.payloadSha256) {
          throw new Error("Delivery id was reused with different payload content");
        }
        const checkpoint = await tx`SELECT last_height FROM ingestion_checkpoints WHERE source_id = ${batch.source} AND network = ${batch.network}`;
        return { duplicate: true, appliedBlocks: 0, rolledBackBlocks: 0, invalidatedSnapshots: 0, checkpointHeight: checkpoint[0] ? Number(checkpoint[0].last_height) : null };
      }

      let invalidatedSnapshots = 0;
      for (const block of batch.rollback) invalidatedSnapshots += await this.rollbackBlock(tx, batch.network, block.indexBlockHash);
      for (const block of batch.apply) invalidatedSnapshots += await this.applyBlock(tx, batch, block, manifest);

      const lastApplied = batch.apply.at(-1);
      if (lastApplied) {
        await tx`
          INSERT INTO ingestion_checkpoints (source_id, network, last_height, last_index_block_hash)
          VALUES (${batch.source}, ${batch.network}, ${lastApplied.height}, ${lastApplied.indexBlockHash})
          ON CONFLICT (source_id, network) DO UPDATE SET
            last_height = EXCLUDED.last_height,
            last_index_block_hash = EXCLUDED.last_index_block_hash,
            updated_at = now()
        `;
      }
      await tx`UPDATE raw_chain_events SET status = 'processed', processed_at = now() WHERE event_key = ${batch.eventKey}`;
      await tx`
        INSERT INTO source_health (source_id, state, last_success_at, observed_height, lag_blocks, detail)
        VALUES (${batch.source}, 'green', now(), ${lastApplied?.height ?? null}, 0, 'Latest Chainhook delivery processed')
        ON CONFLICT (source_id) DO UPDATE SET
          state = 'green', last_success_at = now(), observed_height = EXCLUDED.observed_height,
          lag_blocks = 0, detail = EXCLUDED.detail, updated_at = now()
      `;
      return {
        duplicate: false,
        appliedBlocks: batch.apply.length,
        rolledBackBlocks: batch.rollback.length,
        invalidatedSnapshots,
        checkpointHeight: lastApplied?.height ?? null,
      };
    }) as Promise<IngestionResult>;
  }

  private async rollbackBlock(sql: postgres.TransactionSql, network: string, indexBlockHash: string): Promise<number> {
    await sql`UPDATE chain_blocks SET canonical = false, updated_at = now() WHERE network = ${network} AND index_block_hash = ${indexBlockHash}`;
    await sql`UPDATE chain_transactions SET canonical = false WHERE network = ${network} AND index_block_hash = ${indexBlockHash}`;
    await sql`UPDATE contract_events SET canonical = false WHERE network = ${network} AND index_block_hash = ${indexBlockHash}`;
    await sql`UPDATE protocol_projection_events SET canonical = false WHERE network = ${network} AND index_block_hash = ${indexBlockHash}`;
    await sql`UPDATE projection_issues SET canonical = false WHERE network = ${network} AND index_block_hash = ${indexBlockHash}`;
    const invalidated = await sql`UPDATE position_snapshots SET invalidated_at = now() WHERE network = ${network} AND index_block_hash = ${indexBlockHash} AND invalidated_at IS NULL RETURNING snapshot_id`;
    return invalidated.length;
  }

  private async applyBlock(sql: postgres.TransactionSql, batch: ChainhookBatch, block: IngestedBlock, manifest: RegistryManifest | null): Promise<number> {
    const competing = await sql`SELECT index_block_hash FROM chain_blocks WHERE network = ${batch.network} AND height = ${block.height} AND canonical AND index_block_hash <> ${block.indexBlockHash}`;
    let invalidated = 0;
    for (const row of competing) invalidated += await this.rollbackBlock(sql, batch.network, String(row.index_block_hash));
    await sql`
      INSERT INTO chain_blocks ${sql({
        network: batch.network,
        index_block_hash: block.indexBlockHash,
        block_hash: block.blockHash,
        height: block.height,
        parent_index_block_hash: block.parentIndexBlockHash,
        burn_block_height: block.burnBlockHeight,
        block_time: block.blockTime,
        canonical: true,
        raw_event_key: batch.eventKey,
      })}
      ON CONFLICT (network, index_block_hash) DO UPDATE SET canonical = true, updated_at = now(), raw_event_key = EXCLUDED.raw_event_key
    `;
    for (const transaction of block.transactions) {
      await sql`
        INSERT INTO chain_transactions ${sql({
          network: batch.network,
          tx_id: transaction.txId,
          index_block_hash: block.indexBlockHash,
          tx_index: transaction.txIndex,
          success: transaction.success,
          canonical: true,
          raw: sql.json(transaction.raw as never),
        })}
        ON CONFLICT (network, tx_id, index_block_hash) DO UPDATE SET canonical = true, raw = EXCLUDED.raw
      `;
      for (const event of transaction.events) {
        await sql`
          INSERT INTO contract_events ${sql({
            event_key: event.eventKey,
            network: batch.network,
            tx_id: transaction.txId,
            event_index: event.eventIndex,
            index_block_hash: block.indexBlockHash,
            contract_identifier: event.contractIdentifier,
            topic: event.topic,
            event_type: event.eventType,
            value: sql.json(event.value as never),
            canonical: true,
          })}
          ON CONFLICT (event_key) DO UPDATE SET canonical = true, value = EXCLUDED.value
        `;
      }
    }
    const projected = projectProtocolEvents(batch.network, block, manifest);
    for (const event of projected.projections) {
      await sql`
        INSERT INTO protocol_projection_events ${sql({
          projection_id: event.projectionId, source_event_key: event.sourceEventKey, network: event.network,
          index_block_hash: event.indexBlockHash, block_height: event.blockHeight, tx_id: event.txId,
          event_index: event.eventIndex, protocol: event.protocol, adapter_version: event.adapterVersion,
          kind: event.kind, owner_address: event.ownerAddress, position_key: event.positionKey,
          payload: sql.json(event.payload as never), canonical: true,
        })}
        ON CONFLICT (projection_id) DO UPDATE SET canonical = true, payload = EXCLUDED.payload
      `;
    }
    for (const issue of projected.issues) {
      await sql`
        INSERT INTO projection_issues (source_event_key, network, index_block_hash, protocol, code, detail, canonical)
        VALUES (${issue.sourceEventKey}, ${batch.network}, ${block.indexBlockHash}, ${issue.protocol}, ${issue.code}, ${issue.detail}, true)
        ON CONFLICT (source_event_key, protocol, code, detail) DO UPDATE SET canonical = true
      `;
    }
    return invalidated;
  }

  async canonicalBlock(network: "mainnet" | "testnet", height: number): Promise<CanonicalBlock | null> {
    const rows = await this.sql`SELECT index_block_hash, height, canonical, burn_block_height FROM chain_blocks WHERE network = ${network} AND height = ${height} AND canonical LIMIT 1`;
    const row = rows[0];
    return row ? { network, indexBlockHash: String(row.index_block_hash), height: Number(row.height), canonical: Boolean(row.canonical), burnBlockHeight: row.burn_block_height === null ? null : Number(row.burn_block_height) } : null;
  }

  async canonicalTip(network: "mainnet" | "testnet"): Promise<CanonicalBlock | null> {
    const rows = await this.sql`SELECT index_block_hash, height, canonical, burn_block_height FROM chain_blocks WHERE network = ${network} AND canonical ORDER BY height DESC LIMIT 1`;
    const row = rows[0];
    return row ? { network, indexBlockHash: String(row.index_block_hash), height: Number(row.height), canonical: Boolean(row.canonical), burnBlockHeight: row.burn_block_height === null ? null : Number(row.burn_block_height) } : null;
  }

  async updateSourceHealth(input: { sourceId: string; state: "green" | "amber" | "red"; observedHeight: number | null; lagBlocks: number | null; detail: string | null; success: boolean }): Promise<void> {
    await this.sql`
      INSERT INTO source_health ${this.sql({
        source_id: input.sourceId,
        state: input.state,
        observed_height: input.observedHeight,
        lag_blocks: input.lagBlocks,
        detail: input.detail,
        last_success_at: input.success ? new Date() : null,
        last_failure_at: input.success ? null : new Date(),
      })}
      ON CONFLICT (source_id) DO UPDATE SET
        state = EXCLUDED.state,
        observed_height = EXCLUDED.observed_height,
        lag_blocks = EXCLUDED.lag_blocks,
        detail = EXCLUDED.detail,
        last_success_at = CASE WHEN ${input.success} THEN now() ELSE source_health.last_success_at END,
        last_failure_at = CASE WHEN ${input.success} THEN source_health.last_failure_at ELSE now() END,
        updated_at = now()
    `;
  }

  async sourceHealth() {
    const rows = await this.sql`SELECT source_id, state, observed_height, lag_blocks, detail FROM source_health ORDER BY source_id`;
    return rows.map((row) => ({
      sourceId: String(row.source_id),
      state: String(row.state) as "green" | "amber" | "red",
      observedHeight: row.observed_height === null ? null : Number(row.observed_height),
      lagBlocks: row.lag_blocks === null ? null : Number(row.lag_blocks),
      detail: row.detail === null ? null : String(row.detail),
    }));
  }

  async savePositionSnapshots(input: PositionSnapshotBatch): Promise<number> {
    const positions = input.positions.map((position) => positionSchema.parse(position));
    return this.sql.begin(async (tx) => {
      const block = await tx`SELECT height FROM chain_blocks WHERE network = ${input.network} AND index_block_hash = ${input.indexBlockHash} AND canonical FOR SHARE`;
      if (!block[0] || Number(block[0].height) !== input.blockHeight) throw new Error("Snapshot block is not canonical at the declared height");
      let inserted = 0;
      for (const position of positions) {
        const snapshotId = createHash("sha256").update(canonicalJson({
          network: input.network, address: input.address, indexBlockHash: input.indexBlockHash,
          registryVersion: input.registryVersion, position,
        })).digest("hex");
        const protocol = position.protocol.id;
        const adapterVersion = position.protocol.version;
        const rows = await tx`
          INSERT INTO position_snapshots ${tx({
            snapshot_id: snapshotId, network: input.network, address: input.address, position_id: position.id,
            protocol, adapter_version: adapterVersion, index_block_hash: input.indexBlockHash,
            block_height: input.blockHeight, position: tx.json(position as never),
            lineage: tx.json({ registryVersion: input.registryVersion, provenance: position.provenance } as never),
            confidence: tx.json(position.confidence as never),
          })}
          ON CONFLICT (snapshot_id) DO NOTHING RETURNING snapshot_id
        `;
        inserted += rows.length;
      }
      return inserted;
    }) as Promise<number>;
  }

  async currentPositionSnapshots(network: "mainnet" | "testnet", address: string): Promise<StoredPositionSnapshot[]> {
    const rows = await this.sql`
      SELECT DISTINCT ON (position_id) snapshot_id, index_block_hash, block_height, position, lineage
      FROM position_snapshots
      WHERE network = ${network} AND address = ${address} AND invalidated_at IS NULL
      ORDER BY position_id, block_height DESC, created_at DESC
    `;
    return rows.map((row) => ({
      snapshotId: String(row.snapshot_id), network, address, indexBlockHash: String(row.index_block_hash),
      blockHeight: Number(row.block_height), registryVersion: String((row.lineage as { registryVersion?: unknown }).registryVersion ?? "unknown"),
      position: positionSchema.parse(row.position),
    }));
  }

  async protocolEventsForAddress(network: "mainnet" | "testnet", protocol: "zest" | "bitflow" | "sbtc", address: string): Promise<ProtocolProjection[]> {
    const rows = await this.sql`
      WITH owned AS (
        SELECT DISTINCT position_key FROM protocol_projection_events
        WHERE network = ${network} AND protocol = ${protocol} AND owner_address = ${address} AND canonical
      )
      SELECT event.* FROM protocol_projection_events event JOIN owned USING (position_key)
      WHERE event.network = ${network} AND event.protocol = ${protocol} AND event.canonical
      ORDER BY event.block_height, event.event_index
    `;
    return rows.map((row) => ({
      projectionId: String(row.projection_id), sourceEventKey: String(row.source_event_key), network,
      indexBlockHash: String(row.index_block_hash), blockHeight: Number(row.block_height), txId: String(row.tx_id),
      eventIndex: Number(row.event_index), protocol, adapterVersion: String(row.adapter_version), kind: String(row.kind),
      ownerAddress: row.owner_address === null ? null : String(row.owner_address), positionKey: String(row.position_key),
      payload: row.payload as Record<string, unknown>,
    }));
  }
}
