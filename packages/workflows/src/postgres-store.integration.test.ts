import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresProductStore, createAlertRule, occurrencesForRule, tokenHash } from "./index.js";
import type { RiskFinding, TransactionIntent } from "../../domain/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the PostgreSQL integration suite");
const sql = postgres(databaseUrl, { max: 2 });
const store = new PostgresProductStore(sql);

describe("PostgreSQL product workflows", () => {
  beforeAll(async () => {
    const rows = await sql`SELECT current_database()`;
    if (rows[0]?.current_database !== "riskos_integration") throw new Error("Refusing to clean a database not named riskos_integration");
    await sql`TRUNCATE action_intents, alert_occurrences, alert_rules, wallet_sessions, wallet_challenges CASCADE`;
  });
  afterAll(async () => sql.end({ timeout: 5 }));

  it("atomically consumes challenges and persists only session hashes", async () => {
    const expiresAt = "2026-09-04T12:10:00.000Z";
    await store.putChallenge({ challengeId: "challenge-pg", address: "STTEST", network: "testnet", message: "message", expiresAt, consumedAt: null });
    expect(await store.consumeChallenge("challenge-pg", new Date("2026-09-04T12:00:00.000Z"))).toMatchObject({ consumedAt: "2026-09-04T12:00:00.000Z" });
    expect(await store.consumeChallenge("challenge-pg", new Date("2026-09-04T12:00:01.000Z"))).toBeNull();
    await store.putSession({ tokenHash: tokenHash("secret"), address: "STTEST", network: "testnet", expiresAt });
    expect(await store.session(tokenHash("secret"), new Date("2026-09-04T12:00:00.000Z"))).toMatchObject({ address: "STTEST" });
    await store.revokeSession(tokenHash("secret"));
    expect(await store.session(tokenHash("secret"), new Date("2026-09-04T12:00:00.000Z"))).toBeNull();
  });

  it("persists deduplicated alerts and action state transitions", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const rule = createAlertRule({ address: "STTEST", name: "Risk", categories: ["liquidation"], minimumSeverity: "medium" }, now);
    const risk: RiskFinding = {
      riskId: "risk-pg", positionId: "position-pg", severity: "high", category: "liquidation", score: 90,
      title: "Health is low",
      meaning: "Health is low enough that liquidation can begin on a modest BTC move.",
      whyItMatters: "Collateral can be sold with a penalty.",
      ifYouDoNothing: "Debt can keep accruing and the buffer shrinks.",
      plainMetrics: [],
      evidence: [], scenarios: [], recommendedActions: [],
      model: { id: "test", version: "1" }, confidence: { state: "verified", score: 1, reasons: [] }, expiresAt: "2026-09-04T12:01:00.000Z",
    };
    await store.putAlertRule(rule);
    expect(await store.putOccurrences(occurrencesForRule(rule, [risk], now))).toBe(1);
    expect(await store.putOccurrences(occurrencesForRule(rule, [risk], now))).toBe(0);
    expect(await store.alertOccurrences("STTEST")).toHaveLength(1);

    const intent: TransactionIntent = { intentId: "intent-pg", network: "testnet", status: "ready", expiresAt: "2026-09-04T12:01:00.000Z", reason: { riskId: "risk-pg", targetHealthFactor: "1.35" }, calls: [], guardrails: { maximumStateAgeSeconds: 30, maximumStateBlockDrift: 2, maximumFeeMicroStx: "100" }, simulation: { status: "passed", stateBlock: 1, postHealthFactor: "1.4" }, registryVersion: "test", adapterVersion: "test", warnings: [] };
    await store.putIntent({ intent, address: "STTEST", intentHash: "a".repeat(64), state: "planned", txid: null, updatedAt: now.toISOString() });
    expect(await store.updateIntent(intent.intentId, "wallet-requested", null, now)).toMatchObject({ state: "wallet-requested" });
  });
});
