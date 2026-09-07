import { describe, expect, it } from "vitest";
import { DEMO_ADDRESS, FixtureBitflowAdapter, FixtureWalletAdapter, FixtureZestAdapter } from "../../adapters/src/index.js";
import { evaluateRisks } from "../../risk-engine/src/index.js";
import { analyzePortfolio } from "./index.js";

describe("portfolio analysis", () => {
  it("explains value, concentration, risk drivers, and BTC stress", async () => {
    const positions = [
      ...await new FixtureZestAdapter().discover(DEMO_ADDRESS),
      ...await new FixtureBitflowAdapter().discover(DEMO_ADDRESS),
      ...await new FixtureWalletAdapter().discover(DEMO_ADDRESS),
    ];
    const envelope = {
      address: DEMO_ADDRESS,
      asOf: { stacksBlockHeight: 1, bitcoinBlockHeight: 1, observedAt: "2026-09-04T00:00:00.000Z" },
      positions,
      warnings: [],
    };
    const summary = analyzePortfolio(envelope, evaluateRisks(positions));
    expect(summary).toMatchObject({
      currency: "USD",
      totalAssetsUsd: "90000",
      totalDebtUsd: "45000",
      netWorthUsd: "45000",
      deployedUsd: "80000",
      idleUsd: "5000",
      lockedOrPendingUsd: "5000",
      holdBtcComparisonUsd: "75000",
      holdBtcDeltaUsd: "-30000",
      centralAnswer: expect.objectContaining({ safestAction: expect.any(String) }),
      risk: expect.objectContaining({
        drivers: expect.any(Array),
        classificationMeaning: expect.any(String),
      }),
    });
    expect(summary.allocations.some((item) => item.key === "sBTC")).toBe(true);
    expect(summary.scenarios).toHaveLength(4);
    expect(summary.scenarios[0]?.positionsAffected).toBe(3);
    expect(summary.risk.expectedScoreAfterAction).toBeNull();
    expect(summary.metricMeanings.length).toBeGreaterThan(0);
    expect(summary.deployment.meaning).toContain("deployed");
    expect(summary.btcReferencePriceUsd).toBeNull();
  });

  it("accepts a live DIA BTC reference when provided", async () => {
    const positions = await new FixtureWalletAdapter().discover(DEMO_ADDRESS);
    const envelope = {
      address: DEMO_ADDRESS,
      asOf: { stacksBlockHeight: 1, bitcoinBlockHeight: 1, observedAt: "2026-09-04T00:00:00.000Z" },
      positions,
      warnings: [],
    };
    const summary = analyzePortfolio(envelope, [], { btcReferencePriceUsd: "79791.57" });
    expect(summary.btcReferencePriceUsd).toBe("79791.57");
  });
});
