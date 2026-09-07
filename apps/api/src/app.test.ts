import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEMO_ADDRESS } from "../../../packages/adapters/src/index.js";
import { buildApp } from "./app.js";
import { MemoryDataFoundationStore } from "../../../packages/data-foundation/src/index.js";
import type { RegistryStore, SignedRegistry } from "../../../packages/data-foundation/src/index.js";
import type { ProtocolAdapter } from "../../../packages/domain/src/index.js";

describe("RiskOS API integration", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  async function authenticate(target: FastifyInstance, address = DEMO_ADDRESS) {
    const challengeResponse = await target.inject({ method: "POST", url: "/v1/auth/challenge", payload: { address } });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json();
    const verifyResponse = await target.inject({ method: "POST", url: "/v1/auth/verify", payload: {
      challengeId: challenge.challengeId, address, publicKey: "fixture", signature: `fixture:${challenge.challengeId}`,
    } });
    expect(verifyResponse.statusCode).toBe(200);
    return String(verifyResponse.headers["set-cookie"]);
  }

  it("runs the address-to-risk-to-protection workflow", async () => {
    app = await buildApp({ dataMode: "fixture", now: () => new Date("2026-09-03T15:00:00Z") });
    const positionsResponse = await app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/positions` });
    expect(positionsResponse.statusCode).toBe(200);
    const positions = positionsResponse.json();
    expect(positions.positions).toHaveLength(4);
    expect(positions.positions[0].provenance[0]).toMatchObject({ source: "fixture", blockHeight: 123_456 });

    const riskResponse = await app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/risk` });
    expect(riskResponse.statusCode).toBe(200);
    expect(riskResponse.json().risks).toHaveLength(2);

    const actionPayload = {
      address: DEMO_ADDRESS,
      positionId: positions.positions[0].id,
      action: "repay",
      amountAtomic: "9500000000",
    };
    const previewResponse = await app.inject({
      method: "POST",
      url: "/v1/actions/plan",
      payload: actionPayload,
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.json()).toMatchObject({ status: "ready", network: "testnet", simulation: { status: "passed" }, calls: [] });
    expect(previewResponse.json()).not.toHaveProperty("intentHash");
    expect(previewResponse.json().warnings).toContain("Wallet parameters are withheld until address ownership is authenticated and current evidence is recalculated.");

    const cookie = await authenticate(app);
    const unsaved = await app.inject({ method: "POST", url: `/v1/actions/${previewResponse.json().intentId}/wallet-request`, headers: { cookie } });
    expect(unsaved.statusCode).toBe(404);

    const actionResponse = await app.inject({ method: "POST", url: "/v1/actions/intents", payload: actionPayload, headers: { cookie } });
    expect(actionResponse.statusCode).toBe(201);
    expect(actionResponse.json()).toMatchObject({ status: "ready", network: "testnet", simulation: { status: "passed" } });

    const walletResponse = await app.inject({ method: "POST", url: `/v1/actions/${actionResponse.json().intentId}/wallet-request`, headers: { cookie } });
    expect(walletResponse.statusCode).toBe(200);
    expect(walletResponse.json()).toMatchObject({ mode: "testnet-wallet", method: "stx_callContract" });
    const submitted = await app.inject({ method: "POST", url: `/v1/actions/${actionResponse.json().intentId}/submissions`, headers: { cookie }, payload: { txid: `0x${"ab".repeat(32)}` } });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json()).toMatchObject({ state: "confirmed", reconciliation: "fixture-confirmed" });
  });

  it("keeps intent persistence behind wallet ownership", async () => {
    app = await buildApp({ dataMode: "fixture", now: () => new Date("2026-09-03T15:00:00Z") });
    const positions = (await app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/positions` })).json();
    const payload = { address: DEMO_ADDRESS, positionId: positions.positions[0].id, action: "repay", amountAtomic: "9500000000" };
    const unauthenticated = await app.inject({ method: "POST", url: "/v1/actions/intents", payload });
    expect(unauthenticated.statusCode).toBe(401);
    const otherAddress = "ST000000000000000000002AMW42H";
    const cookie = await authenticate(app, otherAddress);
    const forbidden = await app.inject({ method: "POST", url: "/v1/actions/intents", payload, headers: { cookie } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "ADDRESS_OWNERSHIP_REQUIRED" });
  });

  it("requires wallet ownership and creates deduplicated alert evidence", async () => {
    app = await buildApp({ dataMode: "fixture", network: "testnet", now: () => new Date("2026-09-03T15:00:00Z") });
    const denied = await app.inject({ method: "GET", url: "/v1/alerts" });
    expect(denied.statusCode).toBe(401);
    const cookie = await authenticate(app);
    const created = await app.inject({ method: "POST", url: "/v1/alerts/rules", headers: { cookie }, payload: {
      name: "Material portfolio risk", categories: ["liquidation", "liquidity"], minimumSeverity: "medium",
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json().occurrences).toHaveLength(2);
    const alerts = await app.inject({ method: "GET", url: "/v1/alerts", headers: { cookie } });
    expect(alerts.json()).toMatchObject({ address: DEMO_ADDRESS });
    expect(alerts.json().rules).toHaveLength(1);
    expect(alerts.json().occurrences).toHaveLength(2);
  });

  it("uses an RFC 9457-style problem response for invalid addresses", async () => {
    app = await buildApp({ dataMode: "fixture" });
    const response = await app.inject({ method: "GET", url: "/v1/address/not-an-address/positions" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_ADDRESS", status: 400 });
  });

  it("coalesces concurrent overview reads into one adapter discovery", async () => {
    let discoveries = 0;
    const adapter: ProtocolAdapter = {
      id: "counting",
      async discover() {
        discoveries += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      },
    };
    app = await buildApp({ dataMode: "fixture", adapters: [adapter] });

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/positions` }),
      app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/risk` }),
      app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/portfolio` }),
    ]);

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(discoveries).toBe(1);
  });

  it("authenticates, persists, and deduplicates Chainhook deliveries", async () => {
    const store = new MemoryDataFoundationStore();
    app = await buildApp({
      dataMode: "fixture",
      dataFoundation: store,
      chainhookBearerToken: "test-token-that-is-at-least-32-characters",
      network: "testnet",
    });
    const payload = {
      chainhook: { uuid: "riskos-events" },
      rollback: [],
      apply: [{ block_identifier: { index: 200, hash: "block-200" }, metadata: { index_block_hash: "index-200" }, transactions: [] }],
    };
    const unauthorized = await app.inject({ method: "POST", url: "/v1/ingest/chainhooks/stacks", payload });
    expect(unauthorized.statusCode).toBe(401);
    const headers = { authorization: "Bearer test-token-that-is-at-least-32-characters", "x-chainhook-delivery": "delivery-200" };
    const accepted = await app.inject({ method: "POST", url: "/v1/ingest/chainhooks/stacks", headers, payload });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ duplicate: false, appliedBlocks: 1, checkpointHeight: 200 });
    const duplicate = await app.inject({ method: "POST", url: "/v1/ingest/chainhooks/stacks", headers, payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true, appliedBlocks: 0 });
  });

  it("persists fixture positions only against the exact canonical index-block hash", async () => {
    const store = new MemoryDataFoundationStore();
    const active: SignedRegistry = { algorithm: "ed25519", publicKeyPem: "test", signatureBase64: "test", manifest: {
      version: "2026-09-04.1", network: "mainnet", issuedAt: "2026-09-04T00:00:00.000Z", expiresAt: "2027-09-04T00:00:00.000Z", entries: [],
    } };
    const registryStore: RegistryStore = { active: async () => active, activate: async () => { throw new Error("not used"); } };
    app = await buildApp({ dataMode: "fixture", dataFoundation: store, registryStore, network: "mainnet",
      chainhookBearerToken: "chainhook-token-that-is-at-least-32-characters", operationsBearerToken: "operations-token-that-is-at-least-32-characters" });
    await app.inject({ method: "POST", url: "/v1/ingest/chainhooks/stacks", headers: {
      authorization: "Bearer chainhook-token-that-is-at-least-32-characters", "x-chainhook-delivery": "snapshot-tip",
    }, payload: { rollback: [], apply: [{ block_identifier: { index: 123_456, hash: "block-snapshot" }, metadata: { index_block_hash: "index-snapshot" }, transactions: [] }] } });
    const response = await app.inject({ method: "POST", url: `/v1/operations/snapshots/${DEMO_ADDRESS}`, headers: {
      authorization: "Bearer operations-token-that-is-at-least-32-characters",
    } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ indexBlockHash: "index-snapshot", blockHeight: 123_456, persisted: 4, skipped: [] });
    expect(await store.currentPositionSnapshots("mainnet", DEMO_ADDRESS)).toHaveLength(4);
  });
});
