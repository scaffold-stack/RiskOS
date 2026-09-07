import { describe, expect, it } from "vitest";
import { createAlertRule, MemoryProductStore, occurrencesForRule, randomToken, tokenHash } from "./index.js";
import type { RiskFinding } from "../../domain/src/index.js";

const risk: RiskFinding = {
  riskId: "risk-1", positionId: "position-1", severity: "high", category: "liquidation", score: 90,
  title: "Health is low",
  meaning: "Health is low enough that liquidation can begin on a modest BTC move.",
  whyItMatters: "Collateral can be sold with a penalty.",
  ifYouDoNothing: "Debt can keep accruing and the buffer shrinks.",
  plainMetrics: [{ label: "Health factor", value: "1.05", meaning: "Below the guarded 1.20 band." }],
  evidence: [{ metric: "healthFactor", value: "1.05" }], scenarios: [], recommendedActions: [],
  model: { id: "test", version: "1" }, confidence: { state: "verified", score: 1, reasons: [] }, expiresAt: "2026-09-04T12:01:00.000Z",
};

describe("product workflow store", () => {
  it("deduplicates alert occurrences by rule and risk", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const rule = createAlertRule({ address: "SP000000000000000000002Q6VF78", name: "Liquidation", categories: ["liquidation"], minimumSeverity: "medium" }, now);
    const store = new MemoryProductStore();
    await store.putAlertRule(rule);
    expect(await store.putOccurrences(occurrencesForRule(rule, [risk], now))).toBe(1);
    expect(await store.putOccurrences(occurrencesForRule(rule, [risk], now))).toBe(0);
    expect(await store.alertOccurrences(rule.address)).toHaveLength(1);
  });

  it("stores only hashes of session bearer tokens", async () => {
    const store = new MemoryProductStore();
    const token = randomToken();
    await store.putSession({ tokenHash: tokenHash(token), address: "SP000000000000000000002Q6VF78", network: "testnet", expiresAt: "2026-09-04T12:30:00.000Z" });
    expect(await store.session(token, new Date("2026-09-04T12:00:00.000Z"))).toBeNull();
    expect(await store.session(tokenHash(token), new Date("2026-09-04T12:00:00.000Z"))).not.toBeNull();
  });
});
