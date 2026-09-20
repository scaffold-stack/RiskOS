import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseChainhookPayload } from "./chainhook.js";
import { PostgresDataFoundationStore } from "./postgres-store.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { publicKeyFingerprint, type RegistryManifest } from "./registry.js";
import { PostgresRegistryStore } from "./registry-store.js";
import { buildApp } from "../../../apps/api/src/app.js";
import { Cl, serializeCV } from "@stacks/transactions";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL integration suite");
const sql = postgres(databaseUrl, { max: 2 });
const store = new PostgresDataFoundationStore(sql);

function payload(hash: string, rollback: string[] = []) {
  const makeBlock = (value: string) => ({
    block_identifier: { index: 501, hash: `block-${value}` },
    parent_block_identifier: { index: 500, hash: "block-parent" },
    timestamp: 1_788_400_000,
    metadata: { index_block_hash: `index-${value}`, burn_block_height: 966_851 },
    transactions: [
      {
        transaction_identifier: { hash: `tx-${value}` },
        metadata: {
          success: true,
          receipt: {
            events: [
              { type: "contract_event", data: { contract_identifier: "ST123.protocol", topic: "changed" } },
            ],
          },
        },
      },
    ],
  });
  return {
    chainhook: { uuid: "postgres-test" },
    rollback: rollback.map(makeBlock),
    apply: [makeBlock(hash)],
  };
}

describe("PostgreSQL canonical ingestion", () => {
  beforeAll(async () => {
    const rows = await sql`SELECT current_database()`;
    const database = rows[0]?.current_database;
    if (database !== "riskos_integration")
      throw new Error("Refusing to clean a database not named riskos_integration");
    await sql`TRUNCATE comparison_results, comparison_runs, projection_issues, protocol_projection_events, registry_versions, reconciliation_runs, source_health, ingestion_checkpoints, position_snapshots, contract_events, chain_transactions, chain_blocks, raw_chain_events CASCADE`;
  });

  afterAll(async () => sql.end({ timeout: 5 }));

  it("commits idempotently and atomically replaces a reorged block", async () => {
    const first = parseChainhookPayload(payload("a"), { network: "testnet", deliveryId: "pg-1" });
    expect(await store.ingest(first)).toMatchObject({
      duplicate: false,
      appliedBlocks: 1,
      checkpointHeight: 501,
    });
    expect(await store.ingest(first)).toMatchObject({ duplicate: true, appliedBlocks: 0 });
    const conflictingDelivery = parseChainhookPayload(payload("conflict"), {
      network: "testnet",
      deliveryId: "pg-1",
    });
    await expect(store.ingest(conflictingDelivery)).rejects.toThrow(/reused with different payload/);
    await sql`
      INSERT INTO position_snapshots (
        snapshot_id, network, address, position_id, protocol, adapter_version,
        index_block_hash, block_height, position, lineage, confidence
      ) VALUES (
        'snapshot-pg-a', 'testnet', 'STTEST', 'position-1', 'zest', 'test',
        'index-a', 501, ${sql.json({})}, ${sql.json({})}, ${sql.json({})}
      )
    `;

    const reorg = parseChainhookPayload(payload("b", ["a"]), { network: "testnet", deliveryId: "pg-2" });
    expect(await store.ingest(reorg)).toMatchObject({
      duplicate: false,
      appliedBlocks: 1,
      rolledBackBlocks: 1,
      invalidatedSnapshots: 1,
    });
    expect(await store.canonicalBlock("testnet", 501)).toMatchObject({
      indexBlockHash: "index-b",
      canonical: true,
    });
    const [oldBlock] = await sql`SELECT canonical FROM chain_blocks WHERE index_block_hash = 'index-a'`;
    const [oldSnapshot] =
      await sql`SELECT invalidated_at FROM position_snapshots WHERE snapshot_id = 'snapshot-pg-a'`;
    expect(oldBlock?.canonical).toBe(false);
    expect(oldSnapshot?.invalidated_at).toBeInstanceOf(Date);
  });

  it("activates only a correctly signed registry from a trusted key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const manifest: RegistryManifest = {
      version: "2026-09-03.9",
      network: "testnet",
      issuedAt: "2026-09-03T00:00:00.000Z",
      expiresAt: "2026-10-03T00:00:00.000Z",
      entries: [],
    };
    const signed = {
      manifest,
      algorithm: "ed25519" as const,
      publicKeyPem,
      signatureBase64: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64"),
    };
    const registries = new PostgresRegistryStore(sql);
    const activated = await registries.activate(
      signed,
      new Set([publicKeyFingerprint(publicKeyPem)]),
      new Date("2026-09-04"),
    );
    expect(activated).toMatchObject({ version: manifest.version, network: "testnet" });
    expect((await registries.active("testnet"))?.manifest.version).toBe(manifest.version);
    const alteredManifest = { ...manifest, expiresAt: "2026-11-03T00:00:00.000Z" };
    const altered = {
      ...signed,
      manifest: alteredManifest,
      signatureBase64: sign(null, Buffer.from(canonicalJson(alteredManifest)), privateKey).toString("base64"),
    };
    await expect(
      registries.activate(altered, new Set([publicKeyFingerprint(publicKeyPem)]), new Date("2026-09-04")),
    ).rejects.toThrow(/immutable/);
  });

  it("persists a Chainhook delivery through the real HTTP boundary", async () => {
    const app = await buildApp({
      dataMode: "fixture",
      dataFoundation: store,
      chainhookBearerToken: "postgres-http-token-at-least-32-characters",
      network: "testnet",
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/ingest/chainhooks/stacks",
        headers: {
          authorization: "Bearer postgres-http-token-at-least-32-characters",
          "x-chainhook-delivery": "postgres-http-502",
        },
        payload: {
          chainhook: { uuid: "postgres-http" },
          rollback: [],
          apply: [
            {
              block_identifier: { index: 502, hash: "block-http-502" },
              parent_block_identifier: { index: 501, hash: "block-b" },
              metadata: { index_block_hash: "index-http-502", burn_block_height: 966_852 },
              transactions: [],
            },
          ],
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ appliedBlocks: 1, checkpointHeight: 502 });
      expect(await store.canonicalTip("testnet")).toMatchObject({
        height: 502,
        indexBlockHash: "index-http-502",
      });
    } finally {
      await app.close();
    }
  });

  it("projects a registry-approved event and persists a hash-bound snapshot", async () => {
    const contract = "ST000000000000000000002AMW42H.v0-market-vault";
    const address = "ST000000000000000000002AMW42H";
    const manifest: RegistryManifest = {
      version: "2026-09-04.2",
      network: "testnet",
      issuedAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [
        {
          protocol: "zest-v2",
          adapterVersion: "projection-v1",
          network: "testnet",
          contractPrincipal: contract,
          interfaceHash: `sha256:${"a".repeat(64)}`,
          activationBlock: 1,
          supportedAssets: [],
          assetDefinitions: [],
          readOnlyFunctions: [],
          transactionFunctions: [],
          evidenceUrls: ["https://example.com/contract", "https://example.com/deployment"],
          enabled: true,
        },
      ],
    };
    const value = serializeCV(
      Cl.tuple({
        action: Cl.stringAscii("collateral-add"),
        caller: Cl.standardPrincipal(address),
        data: Cl.tuple({
          account: Cl.standardPrincipal(address),
          amount: Cl.uint(10),
          "asset-id": Cl.uint(5),
          "updated-collateral-amount": Cl.uint(10),
        }),
      }),
    );
    const batch = parseChainhookPayload(
      {
        chainhook: { uuid: "projection-test" },
        rollback: [],
        apply: [
          {
            block_identifier: { index: 503, hash: "block-projection-503" },
            metadata: { index_block_hash: "index-projection-503", burn_block_height: 966_853 },
            transactions: [
              {
                transaction_identifier: { hash: "tx-projection-503" },
                metadata: {
                  success: true,
                  receipt: {
                    events: [
                      {
                        type: "SmartContractEvent",
                        data: { contract_identifier: contract, topic: "print", hex_value: value },
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
      { network: "testnet", deliveryId: "projection-503" },
    );
    await store.ingest(batch, manifest);
    expect(await store.protocolEventsForAddress("testnet", "zest", address)).toMatchObject([
      { kind: "collateral-add", payload: { amountAtomic: "10" } },
    ]);

    const position = {
      id: `zest:${address}`,
      type: "lending" as const,
      protocol: { id: "zest", version: "projection-v1", contract },
      collateral: { asset: "sBTC", amountAtomic: "10", decimals: 8, valueUsd: null },
      debt: { asset: "USDCx", amountAtomic: "0", decimals: 6, valueUsd: null },
      parameters: { liquidationThresholdBps: 8000, maximumLtvBps: 7000 },
      provenance: [
        {
          source: "chainhook" as const,
          blockHeight: 503,
          transactionId: "tx-projection-503",
          observedAt: "2026-09-04T00:00:00.000Z",
        },
      ],
      confidence: { state: "verified" as const, score: 1, reasons: [] },
    };
    expect(
      await store.savePositionSnapshots({
        network: "testnet",
        address,
        indexBlockHash: "index-projection-503",
        blockHeight: 503,
        registryVersion: manifest.version,
        positions: [position],
      }),
    ).toBe(1);
    expect(await store.currentPositionSnapshots("testnet", address)).toMatchObject([
      {
        indexBlockHash: "index-projection-503",
        registryVersion: manifest.version,
        position: { id: position.id },
      },
    ]);
    expect(await store.positionSnapshotHistory("testnet", address, 10)).toMatchObject([
      {
        indexBlockHash: "index-projection-503",
        registryVersion: manifest.version,
        position: { id: position.id },
      },
    ]);
    await expect(
      store.savePositionSnapshots({
        network: "testnet",
        address,
        indexBlockHash: "not-canonical",
        blockHeight: 503,
        registryVersion: manifest.version,
        positions: [position],
      }),
    ).rejects.toThrow(/not canonical/);
  });
});
