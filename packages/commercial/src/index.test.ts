import { describe, expect, it } from "vitest";
import {
  CommercialService,
  MemoryCommercialStore,
  commercialPeriodStart,
  commercialSecretHash,
  hasCommercialFeature,
} from "./index.js";

describe("commercial foundation", () => {
  it("creates one-time API secrets, stores only hashes, and meters atomically", async () => {
    const store = new MemoryCommercialStore();
    const service = new CommercialService(store, () => new Date("2026-09-20T12:00:00Z"));
    const created = await service.createApiKey({
      name: "Wallet production",
      plan: "developer",
      monthlyRequestLimit: 2,
    });

    expect(created.apiKey).toMatch(/^rko_[A-Za-z0-9_-]{40,}$/);
    expect(created.key).not.toHaveProperty("secretHash");
    expect(await store.apiKeyByHash(commercialSecretHash(created.apiKey))).toMatchObject({
      name: "Wallet production",
      plan: "developer",
      monthlyRequestLimit: 2,
    });

    await expect(service.authenticateAndConsume(created.apiKey)).resolves.toMatchObject({
      state: "authenticated",
      usage: { requestCount: 1, remaining: 1 },
    });
    await expect(service.authenticateAndConsume(created.apiKey)).resolves.toMatchObject({
      state: "authenticated",
      usage: { requestCount: 2, remaining: 0 },
    });
    await expect(service.authenticateAndConsume(created.apiKey)).resolves.toMatchObject({
      state: "exhausted",
      usage: { requestCount: 3, remaining: 0 },
    });
    await expect(service.authenticateAndConsume("rko_invalid_but_long_enough")).resolves.toEqual({ state: "invalid" });
  });

  it("revokes API keys and never authenticates them again", async () => {
    const service = new CommercialService(new MemoryCommercialStore(), () => new Date("2026-09-20T12:00:00Z"));
    const created = await service.createApiKey({ name: "Protocol", plan: "protocol" });
    await expect(service.revokeApiKey(created.key.keyId)).resolves.toBe(true);
    await expect(service.revokeApiKey(created.key.keyId)).resolves.toBe(false);
    await expect(service.authenticateAndConsume(created.apiKey)).resolves.toEqual({ state: "invalid" });
  });

  it("creates, lists, meters, and revokes wallet-owned API keys", async () => {
    const service = new CommercialService(new MemoryCommercialStore(), () => new Date("2026-09-20T12:00:00Z"));
    await service.grantWalletPlan({ address: "SP123", plan: "developer" });
    const created = await service.createWalletApiKey("SP123", "Production backend");
    expect(created.key).toMatchObject({
      ownerAddress: "SP123",
      name: "Production backend",
      plan: "developer",
      monthlyRequestLimit: 50_000,
    });
    expect(await service.walletApiKeys("SP999")).toEqual([]);
    await expect(service.walletApiKeys("SP123")).resolves.toMatchObject([
      { key: { keyId: created.key.keyId }, usage: { requestCount: 0, remaining: 50_000 } },
    ]);
    await expect(service.revokeWalletApiKey("SP999", created.key.keyId)).resolves.toBe(false);
    await expect(service.revokeWalletApiKey("SP123", created.key.keyId)).resolves.toBe(true);
  });

  it("allows one 1,000-request key on the free plan", async () => {
    const service = new CommercialService(new MemoryCommercialStore(), () => new Date("2026-09-20T12:00:00Z"));
    const created = await service.createWalletApiKey("SP123", "Free key");
    expect(created.key).toMatchObject({ plan: "free", monthlyRequestLimit: 1_000 });
    await expect(service.createWalletApiKey("SP123", "Second free key")).rejects.toThrow("API_KEY_LIMIT_REACHED");
  });

  it("resolves expiring wallet entitlements and plan capabilities", async () => {
    let now = new Date("2026-09-20T12:00:00Z");
    const service = new CommercialService(new MemoryCommercialStore(), () => now);
    await service.grantWalletPlan({
      address: "SP123",
      plan: "pro",
      endsAt: "2026-10-20T12:00:00Z",
    });
    const active = await service.walletPlan("SP123");
    expect(active.plan.id).toBe("pro");
    expect(hasCommercialFeature(active.plan, "yield-recommend")).toBe(true);

    now = new Date("2026-10-21T12:00:00Z");
    await expect(service.walletPlan("SP123")).resolves.toMatchObject({ plan: { id: "free" }, entitlement: null });
  });

  it("uses UTC calendar months for quotas", () => {
    expect(commercialPeriodStart(new Date("2026-01-31T23:59:59-08:00"))).toBe("2026-02-01");
  });
});
