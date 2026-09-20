import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommercialService, PostgresCommercialStore, commercialSecretHash } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL integration suite");
const sql = postgres(databaseUrl, { max: 2 });
const store = new PostgresCommercialStore(sql);

describe("PostgreSQL commercial foundation", () => {
  beforeAll(async () => {
    const rows = await sql`SELECT current_database()`;
    if (rows[0]?.current_database !== "riskos_integration")
      throw new Error("Refusing to clean a database not named riskos_integration");
    await sql`TRUNCATE commercial_api_usage, commercial_api_keys, commercial_entitlements CASCADE`;
  });

  afterAll(async () => sql.end({ timeout: 5 }));

  it("stores only API key hashes and increments monthly usage atomically", async () => {
    const service = new CommercialService(store, () => new Date("2026-09-20T12:00:00Z"));
    const created = await service.createApiKey({
      name: "Postgres customer",
      plan: "developer",
      monthlyRequestLimit: 10,
    });
    const stored = await store.apiKeyByHash(commercialSecretHash(created.apiKey));
    expect(stored).toMatchObject({ keyId: created.key.keyId, lastUsedAt: null });

    await Promise.all(Array.from({ length: 5 }, () => service.authenticateAndConsume(created.apiKey)));
    await expect(store.apiUsage(created.key.keyId, "2026-09-01")).resolves.toBe(5);
    expect(await store.apiKeyByHash(commercialSecretHash(created.apiKey))).toMatchObject({
      lastUsedAt: "2026-09-20T12:00:00.000Z",
    });
  });

  it("upserts and expires wallet entitlements", async () => {
    let now = new Date("2026-09-20T12:00:00Z");
    const service = new CommercialService(store, () => now);
    await service.grantWalletPlan({
      address: "SPPOSTGRES",
      plan: "pro",
      endsAt: "2026-09-21T12:00:00.000Z",
    });
    await expect(service.walletPlan("SPPOSTGRES")).resolves.toMatchObject({ plan: { id: "pro" } });

    now = new Date("2026-09-22T12:00:00Z");
    await expect(service.walletPlan("SPPOSTGRES")).resolves.toMatchObject({ plan: { id: "free" } });

    await service.grantWalletPlan({ address: "SPPOSTGRES", plan: "treasury" });
    await expect(service.walletPlan("SPPOSTGRES")).resolves.toMatchObject({ plan: { id: "treasury" } });

    await expect(service.walletPlan("UNKNOWN")).resolves.toMatchObject({ plan: { id: "free" } });
  });
});
