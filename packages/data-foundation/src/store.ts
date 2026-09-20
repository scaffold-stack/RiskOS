import type { ChainhookBatch, IngestedBlock } from "./chainhook.js";
import type { Position } from "../../domain/src/index.js";
import type { ProtocolProjection } from "./protocol-projection.js";
import { projectProtocolEvents } from "./protocol-projection.js";
import type { RegistryManifest } from "./registry.js";

export interface IngestionResult {
  duplicate: boolean;
  appliedBlocks: number;
  rolledBackBlocks: number;
  invalidatedSnapshots: number;
  checkpointHeight: number | null;
}

export interface CanonicalBlock {
  network: "mainnet" | "testnet";
  indexBlockHash: string;
  height: number;
  canonical: boolean;
  burnBlockHeight: number | null;
}

export interface DataFoundationStore {
  ingest(batch: ChainhookBatch, manifest?: RegistryManifest | null): Promise<IngestionResult>;
  canonicalBlock(network: "mainnet" | "testnet", height: number): Promise<CanonicalBlock | null>;
  canonicalTip(network: "mainnet" | "testnet"): Promise<CanonicalBlock | null>;
  updateSourceHealth(input: {
    sourceId: string;
    state: "green" | "amber" | "red";
    observedHeight: number | null;
    lagBlocks: number | null;
    detail: string | null;
    success: boolean;
  }): Promise<void>;
  sourceHealth(): Promise<
    Array<{
      sourceId: string;
      state: "green" | "amber" | "red";
      observedHeight: number | null;
      lagBlocks: number | null;
      detail: string | null;
    }>
  >;
  savePositionSnapshots(input: PositionSnapshotBatch): Promise<number>;
  currentPositionSnapshots(
    network: "mainnet" | "testnet",
    address: string,
  ): Promise<StoredPositionSnapshot[]>;
  positionSnapshotHistory(
    network: "mainnet" | "testnet",
    address: string,
    limit: number,
  ): Promise<StoredPositionSnapshot[]>;
  protocolEventsForAddress(
    network: "mainnet" | "testnet",
    protocol: "zest" | "bitflow" | "sbtc",
    address: string,
  ): Promise<ProtocolProjection[]>;
  /** Owner-scoped cash-flow kinds only — never the full position_key event fan-out. */
  cashFlowEventsForAddress(
    network: "mainnet" | "testnet",
    address: string,
    kinds: readonly string[],
    limit?: number,
  ): Promise<ProtocolProjection[]>;
}

export interface PositionSnapshotBatch {
  network: "mainnet" | "testnet";
  address: string;
  indexBlockHash: string;
  blockHeight: number;
  registryVersion: string;
  positions: Position[];
}

export interface StoredPositionSnapshot {
  snapshotId: string;
  network: "mainnet" | "testnet";
  address: string;
  indexBlockHash: string;
  blockHeight: number;
  registryVersion: string;
  position: Position;
}

interface MemoryBlock extends CanonicalBlock {
  block: IngestedBlock;
}

export class MemoryDataFoundationStore implements DataFoundationStore {
  readonly rawEvents = new Map<string, string>();
  readonly blocks = new Map<string, MemoryBlock>();
  readonly snapshots = new Map<
    string,
    { indexBlockHash: string; invalidated: boolean; value?: StoredPositionSnapshot }
  >();
  readonly projections = new Map<string, ProtocolProjection & { canonical: boolean }>();
  readonly health = new Map<
    string,
    {
      state: "green" | "amber" | "red";
      observedHeight: number | null;
      lagBlocks: number | null;
      detail: string | null;
    }
  >();
  checkpointHeight: number | null = null;

  addSnapshot(snapshotId: string, indexBlockHash: string) {
    this.snapshots.set(snapshotId, { indexBlockHash, invalidated: false });
  }

  async ingest(batch: ChainhookBatch, manifest: RegistryManifest | null = null): Promise<IngestionResult> {
    const existingDigest = this.rawEvents.get(batch.eventKey);
    if (existingDigest && existingDigest !== batch.payloadSha256) {
      throw new Error("Delivery id was reused with different payload content");
    }
    if (existingDigest) {
      return {
        duplicate: true,
        appliedBlocks: 0,
        rolledBackBlocks: 0,
        invalidatedSnapshots: 0,
        checkpointHeight: this.checkpointHeight,
      };
    }
    this.rawEvents.set(batch.eventKey, batch.payloadSha256);
    this.health.set(batch.source, {
      state: "green",
      observedHeight: batch.apply.at(-1)?.height ?? null,
      lagBlocks: 0,
      detail: "Latest Chainhook delivery processed",
    });
    let invalidatedSnapshots = 0;
    for (const rollback of batch.rollback) {
      const key = `${batch.network}:${rollback.indexBlockHash}`;
      const existing = this.blocks.get(key);
      if (existing) existing.canonical = false;
      for (const projection of this.projections.values())
        if (projection.indexBlockHash === rollback.indexBlockHash) projection.canonical = false;
      for (const snapshot of this.snapshots.values()) {
        if (snapshot.indexBlockHash === rollback.indexBlockHash && !snapshot.invalidated) {
          snapshot.invalidated = true;
          invalidatedSnapshots++;
        }
      }
    }
    for (const applied of batch.apply) {
      for (const existing of this.blocks.values()) {
        if (
          existing.network === batch.network &&
          existing.height === applied.height &&
          existing.indexBlockHash !== applied.indexBlockHash
        ) {
          existing.canonical = false;
          for (const projection of this.projections.values())
            if (projection.indexBlockHash === existing.indexBlockHash) projection.canonical = false;
          for (const snapshot of this.snapshots.values()) {
            if (snapshot.indexBlockHash === existing.indexBlockHash && !snapshot.invalidated) {
              snapshot.invalidated = true;
              invalidatedSnapshots++;
            }
          }
        }
      }
      this.blocks.set(`${batch.network}:${applied.indexBlockHash}`, {
        network: batch.network,
        indexBlockHash: applied.indexBlockHash,
        height: applied.height,
        canonical: true,
        burnBlockHeight: applied.burnBlockHeight,
        block: applied,
      });
      const projected = projectProtocolEvents(batch.network, applied, manifest);
      for (const projection of projected.projections)
        this.projections.set(projection.projectionId, { ...projection, canonical: true });
      this.checkpointHeight = Math.max(this.checkpointHeight ?? 0, applied.height);
    }
    return {
      duplicate: false,
      appliedBlocks: batch.apply.length,
      rolledBackBlocks: batch.rollback.length,
      invalidatedSnapshots,
      checkpointHeight: this.checkpointHeight,
    };
  }

  async canonicalBlock(network: "mainnet" | "testnet", height: number): Promise<CanonicalBlock | null> {
    return (
      [...this.blocks.values()].find(
        (block) => block.network === network && block.height === height && block.canonical,
      ) ?? null
    );
  }

  async canonicalTip(network: "mainnet" | "testnet"): Promise<CanonicalBlock | null> {
    return (
      [...this.blocks.values()]
        .filter((block) => block.network === network && block.canonical)
        .sort((a, b) => b.height - a.height)[0] ?? null
    );
  }

  async updateSourceHealth(input: {
    sourceId: string;
    state: "green" | "amber" | "red";
    observedHeight: number | null;
    lagBlocks: number | null;
    detail: string | null;
  }): Promise<void> {
    this.health.set(input.sourceId, input);
  }

  async sourceHealth() {
    return [...this.health.entries()].map(([sourceId, value]) => ({ sourceId, ...value }));
  }

  async savePositionSnapshots(input: PositionSnapshotBatch): Promise<number> {
    const block = this.blocks.get(`${input.network}:${input.indexBlockHash}`);
    if (!block?.canonical || block.height !== input.blockHeight)
      throw new Error("Snapshot block is not canonical at the declared height");
    let inserted = 0;
    for (const position of input.positions) {
      const snapshotId = `${input.network}:${input.indexBlockHash}:${input.address}:${position.id}:${input.registryVersion}`;
      if (!this.snapshots.has(snapshotId)) inserted++;
      this.snapshots.set(snapshotId, {
        indexBlockHash: input.indexBlockHash,
        invalidated: false,
        value: {
          snapshotId,
          network: input.network,
          address: input.address,
          indexBlockHash: input.indexBlockHash,
          blockHeight: input.blockHeight,
          registryVersion: input.registryVersion,
          position,
        },
      });
    }
    return inserted;
  }

  async currentPositionSnapshots(
    network: "mainnet" | "testnet",
    address: string,
  ): Promise<StoredPositionSnapshot[]> {
    const latest = new Map<string, StoredPositionSnapshot>();
    for (const snapshot of this.snapshots.values()) {
      if (
        snapshot.invalidated ||
        !snapshot.value ||
        snapshot.value.network !== network ||
        snapshot.value.address !== address
      )
        continue;
      const existing = latest.get(snapshot.value.position.id);
      if (!existing || existing.blockHeight < snapshot.value.blockHeight)
        latest.set(snapshot.value.position.id, snapshot.value);
    }
    return [...latest.values()];
  }

  async positionSnapshotHistory(
    network: "mainnet" | "testnet",
    address: string,
    limit: number,
  ): Promise<StoredPositionSnapshot[]> {
    const observationKeys = [
      ...new Map(
        [...this.snapshots.values()]
          .flatMap((snapshot) => (snapshot.invalidated || !snapshot.value ? [] : [snapshot.value]))
          .filter((snapshot) => snapshot.network === network && snapshot.address === address)
          .map((snapshot) => [`${snapshot.blockHeight}:${snapshot.indexBlockHash}`, snapshot] as const),
      ).entries(),
    ]
      .sort((left, right) => right[1].blockHeight - left[1].blockHeight)
      .slice(0, Math.max(1, limit))
      .map(([key]) => key);
    const allowed = new Set(observationKeys);
    return [...this.snapshots.values()]
      .flatMap((snapshot) => (snapshot.invalidated || !snapshot.value ? [] : [snapshot.value]))
      .filter(
        (snapshot) =>
          snapshot.network === network &&
          snapshot.address === address &&
          allowed.has(`${snapshot.blockHeight}:${snapshot.indexBlockHash}`),
      )
      .sort((a, b) => b.blockHeight - a.blockHeight || a.position.id.localeCompare(b.position.id));
  }

  async protocolEventsForAddress(
    network: "mainnet" | "testnet",
    protocol: "zest" | "bitflow" | "sbtc",
    address: string,
  ): Promise<ProtocolProjection[]> {
    const keys = new Set(
      [...this.projections.values()]
        .filter(
          (event) =>
            event.canonical &&
            event.network === network &&
            event.protocol === protocol &&
            event.ownerAddress === address,
        )
        .map((event) => event.positionKey),
    );
    return [...this.projections.values()].filter(
      (event) =>
        event.canonical &&
        event.network === network &&
        event.protocol === protocol &&
        keys.has(event.positionKey),
    );
  }

  async cashFlowEventsForAddress(
    network: "mainnet" | "testnet",
    address: string,
    kinds: readonly string[],
    limit = 500,
  ): Promise<ProtocolProjection[]> {
    const kindSet = new Set(kinds);
    return [...this.projections.values()]
      .filter(
        (event) =>
          event.canonical &&
          event.network === network &&
          event.ownerAddress === address &&
          (event.protocol === "zest" || event.protocol === "bitflow") &&
          kindSet.has(event.kind),
      )
      .sort((a, b) => b.blockHeight - a.blockHeight || b.eventIndex - a.eventIndex)
      .slice(0, Math.max(1, limit))
      .sort((a, b) => a.blockHeight - b.blockHeight || a.eventIndex - b.eventIndex);
  }
}
