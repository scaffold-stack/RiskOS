import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEMO_ADDRESS, type YieldMarket } from "../../../packages/adapters/src/index.js";
import { buildApp } from "./app.js";
import { MemoryDataFoundationStore } from "../../../packages/data-foundation/src/index.js";
import type { RegistryStore, SignedRegistry } from "../../../packages/data-foundation/src/index.js";
import type { ProtocolAdapter } from "../../../packages/domain/src/index.js";

describe("RiskOS API integration", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  async function authenticate(target: FastifyInstance, address = DEMO_ADDRESS) {
    const challengeResponse = await target.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { address },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json();
    const verifyResponse = await target.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: {
        challengeId: challenge.challengeId,
        address,
        publicKey: "fixture",
        signature: `fixture:${challenge.challengeId}`,
      },
    });
    expect(verifyResponse.statusCode).toBe(200);
    return String(verifyResponse.headers["set-cookie"]);
  }

  async function authenticateBearer(target: FastifyInstance, address = DEMO_ADDRESS) {
    const challengeResponse = await target.inject({
      method: "POST",
      url: "/v1/auth/challenge",
      payload: { address },
    });
    const challenge = challengeResponse.json();
    const verifyResponse = await target.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: {
        challengeId: challenge.challengeId,
        address,
        publicKey: "fixture",
        signature: `fixture:${challenge.challengeId}`,
      },
    });
    expect(verifyResponse.statusCode).toBe(200);
    expect(verifyResponse.json().token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    return String(verifyResponse.json().token);
  }

  it("runs the address-to-risk-to-protection workflow", async () => {
    app = await buildApp({ dataMode: "fixture", now: () => new Date("2026-09-03T15:00:00Z") });
    const overviewResponse = await app.inject({
      method: "GET",
      url: `/v1/address/${DEMO_ADDRESS}/overview`,
    });
    expect(overviewResponse.statusCode).toBe(200);
    const overview = overviewResponse.json();
    expect(overview.positions.positions).toHaveLength(4);
    expect(overview.risks).toHaveLength(2);
    expect(overview.portfolio.address).toBe(DEMO_ADDRESS);

    const positionsResponse = await app.inject({
      method: "GET",
      url: `/v1/address/${DEMO_ADDRESS}/positions`,
    });
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
    expect(previewResponse.json()).toMatchObject({
      status: "ready",
      network: "testnet",
      simulation: { status: "passed" },
      calls: [],
    });
    expect(previewResponse.json()).not.toHaveProperty("intentHash");
    expect(previewResponse.json().warnings).toContain(
      "Wallet parameters are withheld until address ownership is authenticated and current evidence is recalculated.",
    );

    const cookie = await authenticate(app);
    const unsaved = await app.inject({
      method: "POST",
      url: `/v1/actions/${previewResponse.json().intentId}/wallet-request`,
      headers: { cookie },
    });
    expect(unsaved.statusCode).toBe(404);

    const actionResponse = await app.inject({
      method: "POST",
      url: "/v1/actions/intents",
      payload: actionPayload,
      headers: { cookie },
    });
    expect(actionResponse.statusCode).toBe(201);
    expect(actionResponse.json()).toMatchObject({
      status: "ready",
      network: "testnet",
      simulation: { status: "passed" },
    });

    const walletResponse = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionResponse.json().intentId}/wallet-request`,
      headers: { cookie },
    });
    expect(walletResponse.statusCode).toBe(200);
    expect(walletResponse.json()).toMatchObject({ mode: "testnet-wallet", method: "stx_callContract" });
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/actions/${actionResponse.json().intentId}/submissions`,
      headers: { cookie },
      payload: { txid: `0x${"ab".repeat(32)}` },
    });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json()).toMatchObject({ state: "confirmed", reconciliation: "fixture-confirmed" });
  });

  it("discovers markets independently of a wallet and returns an automatic allocation", async () => {
    app = await buildApp({ dataMode: "fixture", now: () => new Date("2026-09-13T12:00:00Z") });
    const markets = await app.inject({ method: "GET", url: "/v1/yield/markets" });
    expect(markets.statusCode).toBe(200);
    expect(markets.json().markets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ protocol: "zest", eligibleForAllocation: true }),
        expect.objectContaining({ protocol: "bitflow", eligibleForAllocation: true }),
      ]),
    );
    const strategies = await app.inject({ method: "GET", url: "/v1/yield/strategies" });
    expect(strategies.statusCode).toBe(200);
    expect(strategies.json()).toMatchObject({
      asOf: "2026-09-13T12:00:00.000Z",
      strategies: expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^yield:/),
          protocol: "zest",
          modes: ["explore", "recommend"],
          eligibleForRecommendation: true,
        }),
      ]),
    });

    const plan = await app.inject({
      method: "POST",
      url: "/v1/yield/allocations",
      payload: { capitalUsd: "1000000", days: 365 },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({
      capitalUsd: "1000000.00",
      allocatedUsd: "1000000.00",
      unallocatedUsd: "0.00",
      allocations: [
        expect.objectContaining({ protocol: "bitflow", amountUsd: "600000.00" }),
        expect.objectContaining({ protocol: "zest", amountUsd: "400000.00" }),
      ],
    });
    expect(plan.json()).toMatchObject({
      generatedAt: "2026-09-13T12:00:00.000Z",
      evidenceAsOf: "2026-09-13T12:00:00.000Z",
      allocations: [
        expect.objectContaining({
          rateLabel: "Fee APR",
          confidenceScore: 0.9,
          observedAtBlock: 123_456,
        }),
        expect.objectContaining({ rateLabel: "Supply APR", confidenceScore: 0.92 }),
      ],
    });

    for (const capitalUsd of ["0", "1000000000000.01"]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/yield/allocations",
        payload: { capitalUsd, days: 365 },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: "INVALID_YIELD_INPUT" });
    }
  });

  it("does not allocate capital from stale cached market evidence", async () => {
    const stale: YieldMarket = {
      id: "stale:zest",
      protocol: "zest",
      kind: "lending",
      assets: "STX",
      annualizedRateBps: 900,
      rateLabel: "Supply APR",
      evidenceState: "verified",
      confidenceScore: 0.92,
      observedAtBlock: 123_456,
      observedAt: "2026-09-13T10:59:59.000Z",
      tvlUsd: null,
      independentRateEvidence: null,
      capacityEvidence: null,
      source: "stale-fixture",
      meaning: "Test stale evidence.",
      eligibleForAllocation: true,
    };
    app = await buildApp({
      dataMode: "fixture",
      now: () => new Date("2026-09-13T12:00:00.000Z"),
      yieldMarketProvider: async () => [stale],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/yield/allocations",
      payload: { capitalUsd: "1000", days: 30 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      allocatedUsd: "0.00",
      unallocatedUsd: "1000.00",
      markets: [expect.objectContaining({
        eligibleForAllocation: false,
        allocationExclusionReason: "Rate evidence is stale (3601s old; maximum 3600s).",
      })],
    });
  });

  it("expires the market cache before allocatable evidence becomes stale", async () => {
    let clock = new Date("2026-09-13T12:00:00.000Z");
    let reads = 0;
    app = await buildApp({
      dataMode: "fixture",
      now: () => clock,
      yieldMarketProvider: async () => {
        reads += 1;
        return [{
          id: "fresh:zest",
          protocol: "zest",
          kind: "lending",
          assets: "STX",
          annualizedRateBps: 500,
          rateLabel: "Supply APR",
          evidenceState: "verified",
          confidenceScore: 0.92,
          observedAtBlock: 123_456 + reads,
          observedAt: clock.toISOString(),
          tvlUsd: "1000000",
          independentRateEvidence: { source: "test-comparison", observedAt: clock.toISOString(), annualizedRateBps: 500, differenceBps: 0 },
          capacityEvidence: { source: "test-capacity", observedAt: clock.toISOString(), tvlUsd: "1000000" },
          source: "cache-fixture",
          meaning: "Test cache evidence.",
          eligibleForAllocation: true,
        }];
      },
    });
    await app.inject({ method: "GET", url: "/v1/yield/markets" });
    clock = new Date("2026-09-13T12:03:59.000Z");
    await app.inject({ method: "GET", url: "/v1/yield/markets" });
    expect(reads).toBe(1);
    clock = new Date("2026-09-13T12:05:01.000Z");
    await app.inject({ method: "GET", url: "/v1/yield/markets" });
    expect(reads).toBe(2);
  });

  it("applies warm market rates to receipt tokens without blocking cold discovery", async () => {
    let marketReads = 0;
    const adapter: ProtocolAdapter = {
      id: "concurrency-test",
      async discover() {
        return [{
          id: "zest:zststx:wallet",
          type: "supply" as const,
          protocol: { id: "zest", version: "v2", contract: "SP.contract" },
          asset: { asset: "zstSTX", amountAtomic: "1000000", decimals: 6, valueUsd: null },
          provenance: [{ source: "stacks-api" as const, blockHeight: 99, observedAt: "2026-09-15T08:00:00.000Z" }],
          confidence: { state: "verified" as const, score: 0.9, reasons: [] },
        }];
      },
    };
    const market: YieldMarket = {
      id: "zest:ststx",
      protocol: "zest",
      kind: "lending",
      assets: "stSTX",
      annualizedRateBps: 10,
      rateLabel: "Supply APR",
      evidenceState: "verified",
      confidenceScore: 0.92,
      observedAtBlock: 99,
      observedAt: "2026-09-15T08:00:00.000Z",
      tvlUsd: null,
      independentRateEvidence: null,
      capacityEvidence: null,
      source: "SP.vault-ststx",
      meaning: "Pinned test rate.",
      eligibleForAllocation: true,
    };
    app = await buildApp({
      dataMode: "live",
      adapters: [adapter],
      priceBook: { quote: async () => null },
      yieldMarketProvider: async () => {
        marketReads += 1;
        return [market];
      },
      now: () => new Date("2026-09-15T08:00:00.000Z"),
    });

    const response = await app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/positions` });
    expect(response.statusCode).toBe(200);
    expect(marketReads).toBe(1);
    expect(response.json().positions[0].earnings).toMatchObject({
      annualizedRateBps: 10,
      observedAtBlock: 99,
      confidence: { state: "verified" },
    });
  });

  it("keeps intent persistence behind wallet ownership", async () => {
    app = await buildApp({ dataMode: "fixture", now: () => new Date("2026-09-03T15:00:00Z") });
    const positions = (
      await app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/positions` })
    ).json();
    const payload = {
      address: DEMO_ADDRESS,
      positionId: positions.positions[0].id,
      action: "repay",
      amountAtomic: "9500000000",
    };
    const unauthenticated = await app.inject({ method: "POST", url: "/v1/actions/intents", payload });
    expect(unauthenticated.statusCode).toBe(401);
    const otherAddress = "ST000000000000000000002AMW42H";
    const cookie = await authenticate(app, otherAddress);
    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/actions/intents",
      payload,
      headers: { cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "ADDRESS_OWNERSHIP_REQUIRED" });
  });

  it("requires wallet ownership and creates deduplicated alert evidence", async () => {
    app = await buildApp({
      dataMode: "fixture",
      network: "testnet",
      now: () => new Date("2026-09-03T15:00:00Z"),
    });
    const denied = await app.inject({ method: "GET", url: "/v1/alerts" });
    expect(denied.statusCode).toBe(401);
    const cookie = await authenticate(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/alerts/rules",
      headers: { cookie },
      payload: {
        name: "Material portfolio risk",
        categories: ["liquidation", "liquidity"],
        minimumSeverity: "medium",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().occurrences).toHaveLength(2);
    const alerts = await app.inject({ method: "GET", url: "/v1/alerts", headers: { cookie } });
    expect(alerts.json()).toMatchObject({ address: DEMO_ADDRESS });
    expect(alerts.json().rules).toHaveLength(1);
    expect(alerts.json().occurrences).toHaveLength(2);
    const limited = await app.inject({
      method: "POST",
      url: "/v1/alerts/rules",
      headers: { cookie },
      payload: {
        name: "Second free rule",
        categories: ["oracle"],
        minimumSeverity: "high",
      },
    });
    expect(limited.statusCode).toBe(403);
    expect(limited.json()).toMatchObject({ code: "ALERT_LIMIT_REACHED" });
  });

  it("publishes honest plans and enforces API key quotas and paid recommendation mode", async () => {
    const operationsBearerToken = "operations-token-that-is-at-least-32-characters";
    app = await buildApp({
      dataMode: "fixture",
      operationsBearerToken,
      now: () => new Date("2026-09-20T12:00:00Z"),
    });

    const plans = await app.inject({ method: "GET", url: "/v1/plans" });
    expect(plans.statusCode).toBe(200);
    expect(plans.json()).toMatchObject({
      billingState: "manual-provisioning",
      executionFeesEnabled: false,
      plans: expect.arrayContaining([
        expect.objectContaining({ id: "free", priceUsdMonthly: 0 }),
        expect.objectContaining({ id: "developer", priceUsdMonthly: 399 }),
      ]),
    });

    const paidModeDenied = await app.inject({
      method: "POST",
      url: "/v1/yield/allocations",
      payload: { capitalUsd: "1000", days: 30, mode: "recommend" },
    });
    expect(paidModeDenied.statusCode).toBe(403);
    expect(paidModeDenied.json()).toMatchObject({ code: "UPGRADE_REQUIRED" });

    const provisioned = await app.inject({
      method: "POST",
      url: "/v1/operations/api-keys",
      headers: { authorization: `Bearer ${operationsBearerToken}` },
      payload: { name: "SDK customer", plan: "developer", monthlyRequestLimit: 2 },
    });
    expect(provisioned.statusCode).toBe(201);
    const apiKey = String(provisioned.json().apiKey);
    expect(apiKey).toMatch(/^rko_/);
    expect(provisioned.json().key).not.toHaveProperty("secretHash");

    const usage = await app.inject({
      method: "GET",
      url: "/v1/developer/usage",
      headers: { "x-api-key": apiKey },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toMatchObject({ requestCount: 1, remaining: 1 });
    expect(usage.headers["x-ratelimit-remaining"]).toBe("1");

    const paidMode = await app.inject({
      method: "POST",
      url: "/v1/yield/allocations",
      headers: { "x-api-key": apiKey },
      payload: { capitalUsd: "1000", days: 30, mode: "recommend" },
    });
    expect(paidMode.statusCode).toBe(200);
    expect(paidMode.json()).toMatchObject({ mode: "recommend" });

    const exhausted = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-api-key": apiKey },
    });
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json()).toMatchObject({ code: "API_QUOTA_EXCEEDED" });
    expect(Number(exhausted.headers["retry-after"])).toBeGreaterThan(0);
    expect(exhausted.headers["x-ratelimit-reset"]).toBe("2026-10-01T00:00:00.000Z");
  });

  it("lets an entitled wallet create, list, use, and revoke its own API keys", async () => {
    const operationsBearerToken = "operations-token-that-is-at-least-32-characters";
    app = await buildApp({
      dataMode: "fixture",
      operationsBearerToken,
      now: () => new Date("2026-09-20T12:00:00Z"),
    });
    const sessionToken = await authenticateBearer(app);
    const authorization = `Bearer ${sessionToken}`;

    const freeAccess = await app.inject({
      method: "GET",
      url: "/v1/account/api-keys",
      headers: { authorization },
    });
    expect(freeAccess.statusCode).toBe(200);
    expect(freeAccess.json()).toMatchObject({ canCreate: true, maximumActiveKeys: 1, keys: [] });

    const freeKey = await app.inject({
      method: "POST",
      url: "/v1/account/api-keys",
      headers: { authorization },
      payload: { name: "Free development key" },
    });
    expect(freeKey.statusCode).toBe(201);
    expect(freeKey.json()).toMatchObject({
      key: { plan: "free", monthlyRequestLimit: 1_000 },
    });
    const freeUsage = await app.inject({
      method: "GET",
      url: "/v1/developer/usage",
      headers: { "x-api-key": String(freeKey.json().apiKey) },
    });
    expect(freeUsage.json().usage).toMatchObject({ requestCount: 1, remaining: 999 });

    const limited = await app.inject({
      method: "POST",
      url: "/v1/account/api-keys",
      headers: { authorization },
      payload: { name: "Second free key" },
    });
    expect(limited.statusCode).toBe(409);
    expect(limited.json()).toMatchObject({ code: "API_KEY_LIMIT_REACHED" });

    const revokeFree = await app.inject({
      method: "POST",
      url: `/v1/account/api-keys/${freeKey.json().key.keyId}/revoke`,
      headers: { authorization },
    });
    expect(revokeFree.statusCode).toBe(200);

    const entitlement = await app.inject({
      method: "POST",
      url: "/v1/operations/entitlements",
      headers: { authorization: `Bearer ${operationsBearerToken}` },
      payload: { address: DEMO_ADDRESS, plan: "developer" },
    });
    expect(entitlement.statusCode).toBe(201);

    const created = await app.inject({
      method: "POST",
      url: "/v1/account/api-keys",
      headers: { authorization },
      payload: { name: "Production backend" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      apiKey: expect.stringMatching(/^rko_/),
      key: { ownerAddress: DEMO_ADDRESS, name: "Production backend", plan: "developer" },
    });

    const apiKey = String(created.json().apiKey);
    const usage = await app.inject({
      method: "GET",
      url: "/v1/developer/usage",
      headers: { "x-api-key": apiKey },
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage).toMatchObject({ requestCount: 1, remaining: 49_999 });

    const listed = await app.inject({
      method: "GET",
      url: "/v1/account/api-keys",
      headers: { authorization },
    });
    expect(listed.json()).toMatchObject({
      canCreate: true,
      maximumActiveKeys: 5,
      keys: expect.arrayContaining([
        expect.objectContaining({
          key: expect.objectContaining({ keyId: created.json().key.keyId }),
          usage: expect.objectContaining({ requestCount: 1 }),
        }),
      ]),
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/account/api-keys/${created.json().key.keyId}/revoke`,
      headers: { authorization },
    });
    expect(revoked.statusCode).toBe(200);
    const rejected = await app.inject({
      method: "GET",
      url: "/v1/developer/usage",
      headers: { "x-api-key": apiKey },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it("bounds anonymous expensive reads without rate-limiting health checks", async () => {
    app = await buildApp({
      dataMode: "fixture",
      publicRateLimitPerMinute: 2,
      now: () => new Date("2026-09-20T12:00:00Z"),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const allowed = await app.inject({ method: "GET", url: "/v1/address/not-an-address/positions" });
      expect(allowed.statusCode).toBe(400);
      expect(allowed.headers["x-ratelimit-scope"]).toBe("anonymous-ip");
    }
    const limited = await app.inject({ method: "GET", url: "/v1/address/not-an-address/positions" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "PUBLIC_RATE_LIMIT_EXCEEDED" });
    expect(limited.headers["retry-after"]).toBe("60");

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
  });

  it("generates owner-authenticated evidence reports only for entitled wallets", async () => {
    const operationsBearerToken = "operations-token-that-is-at-least-32-characters";
    app = await buildApp({
      dataMode: "fixture",
      network: "testnet",
      operationsBearerToken,
      now: () => new Date("2026-09-20T12:00:00Z"),
    });
    const cookie = await authenticate(app);
    const freeReport = await app.inject({
      method: "GET",
      url: "/v1/reports/portfolio",
      headers: { cookie },
    });
    expect(freeReport.statusCode).toBe(403);
    expect(freeReport.json()).toMatchObject({ code: "UPGRADE_REQUIRED" });

    const granted = await app.inject({
      method: "POST",
      url: "/v1/operations/entitlements",
      headers: { authorization: `Bearer ${operationsBearerToken}` },
      payload: {
        address: DEMO_ADDRESS,
        plan: "pro",
        endsAt: "2026-10-20T12:00:00.000Z",
      },
    });
    expect(granted.statusCode).toBe(201);

    const report = await app.inject({
      method: "GET",
      url: "/v1/reports/portfolio",
      headers: { cookie },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      schemaVersion: "riskos.report.v1",
      address: DEMO_ADDRESS,
      plan: "pro",
      portfolio: { address: DEMO_ADDRESS },
      positions: { address: DEMO_ADDRESS },
      integrity: {
        walletOwnershipAuthenticated: true,
        currentEvidenceOnly: true,
      },
    });
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
      apply: [
        {
          block_identifier: { index: 200, hash: "block-200" },
          metadata: { index_block_hash: "index-200" },
          transactions: [],
        },
      ],
    };
    const unauthorized = await app.inject({ method: "POST", url: "/v1/ingest/chainhooks/stacks", payload });
    expect(unauthorized.statusCode).toBe(401);
    const headers = {
      authorization: "Bearer test-token-that-is-at-least-32-characters",
      "x-chainhook-delivery": "delivery-200",
    };
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/ingest/chainhooks/stacks",
      headers,
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ duplicate: false, appliedBlocks: 1, checkpointHeight: 200 });
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/ingest/chainhooks/stacks",
      headers,
      payload,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ duplicate: true, appliedBlocks: 0 });
  });

  it("persists fixture positions only against the exact canonical index-block hash", async () => {
    const store = new MemoryDataFoundationStore();
    const active: SignedRegistry = {
      algorithm: "ed25519",
      publicKeyPem: "test",
      signatureBase64: "test",
      manifest: {
        version: "2026-09-04.1",
        network: "mainnet",
        issuedAt: "2026-09-04T00:00:00.000Z",
        expiresAt: "2027-09-04T00:00:00.000Z",
        entries: [],
      },
    };
    const registryStore: RegistryStore = {
      active: async () => active,
      activate: async () => {
        throw new Error("not used");
      },
    };
    app = await buildApp({
      dataMode: "fixture",
      dataFoundation: store,
      registryStore,
      network: "mainnet",
      chainhookBearerToken: "chainhook-token-that-is-at-least-32-characters",
      operationsBearerToken: "operations-token-that-is-at-least-32-characters",
    });
    await app.inject({
      method: "POST",
      url: "/v1/ingest/chainhooks/stacks",
      headers: {
        authorization: "Bearer chainhook-token-that-is-at-least-32-characters",
        "x-chainhook-delivery": "snapshot-tip",
      },
      payload: {
        rollback: [],
        apply: [
          {
            block_identifier: { index: 123_456, hash: "block-snapshot" },
            metadata: { index_block_hash: "index-snapshot" },
            transactions: [],
          },
        ],
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/operations/snapshots/${DEMO_ADDRESS}`,
      headers: {
        authorization: "Bearer operations-token-that-is-at-least-32-characters",
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      indexBlockHash: "index-snapshot",
      blockHeight: 123_456,
      persisted: 4,
      skipped: [],
    });
    expect(await store.currentPositionSnapshots("mainnet", DEMO_ADDRESS)).toHaveLength(4);
    const history = await app.inject({ method: "GET", url: `/v1/address/${DEMO_ADDRESS}/history` });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      address: DEMO_ADDRESS,
      observations: [
        {
          indexBlockHash: "index-snapshot",
          blockHeight: 123_456,
          positions: [],
          valuedNetSubtotalUsd: "45000",
          valuedAssetsSubtotalUsd: "90000",
          valuedDebtSubtotalUsd: "45000",
          valuedPositionCount: 4,
          excludedPositionCount: 0,
          complete: true,
        },
      ],
      cashFlows: [],
      integrity: {
        canonicalOnly: true,
        reorgInvalidatedSnapshotsExcluded: true,
        state: "baseline-only",
      },
      earnedYield: {
        valueUsd: null,
        state: "cash-flow-history-required",
      },
    });
    const limitedHistory = await app.inject({
      method: "GET",
      url: `/v1/address/${DEMO_ADDRESS}/history?limit=1`,
    });
    expect(limitedHistory.json().observations[0].positions).toHaveLength(0);
    expect(limitedHistory.json().observations[0].valuedPositionCount).toBe(4);
  });
});
