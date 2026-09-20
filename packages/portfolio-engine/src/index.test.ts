import { describe, expect, it } from "vitest";
import {
  DEMO_ADDRESS,
  FixtureBitflowAdapter,
  FixtureWalletAdapter,
  FixtureZestAdapter,
} from "../../adapters/src/index.js";
import { evaluateRisks } from "../../risk-engine/src/index.js";
import { analyzePortfolio } from "./index.js";

describe("portfolio analysis", () => {
  it("explains value, concentration, risk drivers, and BTC stress", async () => {
    const positions = [
      ...(await new FixtureZestAdapter().discover(DEMO_ADDRESS)),
      ...(await new FixtureBitflowAdapter().discover(DEMO_ADDRESS)),
      ...(await new FixtureWalletAdapter().discover(DEMO_ADDRESS)),
    ];
    const envelope = {
      address: DEMO_ADDRESS,
      asOf: { stacksBlockHeight: 1, bitcoinBlockHeight: 1, observedAt: "2026-09-04T00:00:00.000Z" },
      positions,
      warnings: [],
    };
    const summary = analyzePortfolio(envelope, evaluateRisks(positions), { allowFixtureEvidence: true });
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
    const summary = analyzePortfolio(envelope, [], {
      btcReferencePriceUsd: "79791.57",
      allowFixtureEvidence: true,
    });
    expect(summary.btcReferencePriceUsd).toBe("79791.57");
  });

  it("withholds totals instead of treating an unpriced debt as zero", async () => {
    const positions = await new FixtureZestAdapter().discover(DEMO_ADDRESS);
    const lending = positions.find((position) => position.type === "lending");
    if (!lending || lending.type !== "lending") throw new Error("fixture lending position missing");
    lending.debt.valueUsd = null;
    const summary = analyzePortfolio(
      {
        address: DEMO_ADDRESS,
        asOf: {
          stacksBlockHeight: 1,
          bitcoinBlockHeight: 1,
          observedAt: "2026-09-04T00:00:00.000Z",
        },
        positions,
        warnings: [],
      },
      [],
    );
    expect(summary).toMatchObject({
      totalAssetsUsd: null,
      totalDebtUsd: null,
      netWorthUsd: null,
      missingValuationCount: 1,
      allocations: [],
      scenarios: expect.arrayContaining([
        expect.objectContaining({ estimatedNetValueUsd: null, estimatedLossUsd: null }),
      ]),
    });
    expect(summary.data.warnings).toEqual([]);
    expect(summary.headline).toMatch(/valued net subtotal|unavailable/i);
  });

  it("withholds populated dollar values when position evidence is only estimated", async () => {
    const positions = await new FixtureWalletAdapter().discover(DEMO_ADDRESS);
    for (const position of positions) {
      if (position.type !== "wallet") continue;
      position.asset.valuation = {
        priceUsd: position.asset.asset === "STX" ? "0.2" : "100000",
        source: "multi-source-consensus",
        observedAt: "2026-09-04T00:00:00.000Z",
        ageSeconds: 10,
        confidence: 0.88,
        meaning: "Two-source test quorum",
      };
    }
    const summary = analyzePortfolio(
      {
        address: DEMO_ADDRESS,
        asOf: {
          stacksBlockHeight: 1,
          bitcoinBlockHeight: 1,
          observedAt: "2026-09-04T00:00:00.000Z",
        },
        positions,
        warnings: [],
      },
      [],
    );
    expect(summary.netWorthUsd).toBeNull();
    expect(summary.valuedSubtotalUsd).toBe("10000");
    expect(summary.valuedSubtotalPositionCount).toBe(2);
    expect(summary).toMatchObject({
      valuedAssetsSubtotalUsd: "10000",
      valuedDebtSubtotalUsd: "0",
      valuedDeployedSubtotalUsd: "0",
      valuedIdleSubtotalUsd: "5000",
      valuedLockedSubtotalUsd: "5000",
      valuedBtcExposureSubtotalUsd: "5000",
      valuedNetVsBtcExposureUsd: "5000",
      scenarios: expect.arrayContaining([
        expect.objectContaining({
          scope: "valued-subset",
          excludedPositionCount: 0,
          estimatedNetValueUsd: expect.any(String),
        }),
      ]),
    });
    expect(summary.data.state).toBe("partial");
    expect(summary.data.warnings).toEqual([]);
    expect(summary.missingValuationCount).toBeGreaterThan(0);
  });

  it("sums multi-leg lending collateral and debt for portfolio totals and BTC stress", () => {
    const valuation = {
      priceUsd: "100000",
      source: "multi-source-consensus" as const,
      observedAt: "2026-09-04T00:00:00.000Z",
      ageSeconds: 10,
      confidence: 0.95,
      meaning: "test quorum",
    };
    const position = {
      id: "zest-multi",
      type: "lending" as const,
      protocol: { id: "zest", version: "test", contract: "SP.TEST" },
      collateral: {
        asset: "sBTC",
        amountAtomic: "100000000",
        decimals: 8,
        valueUsd: "100000",
        valuation,
      },
      debt: {
        asset: "USDCx",
        amountAtomic: "20000000000",
        decimals: 6,
        valueUsd: "20000",
        valuation: { ...valuation, priceUsd: "1" },
      },
      legs: {
        collateral: [
          {
            asset: "sBTC",
            amountAtomic: "100000000",
            decimals: 8,
            valueUsd: "100000",
            valuation,
          },
          {
            asset: "stBTC",
            amountAtomic: "50000000",
            decimals: 8,
            valueUsd: "50000",
            valuation,
          },
        ],
        debt: [
          {
            asset: "USDCx",
            amountAtomic: "20000000000",
            decimals: 6,
            valueUsd: "20000",
            valuation: { ...valuation, priceUsd: "1" },
          },
          {
            asset: "USDH",
            amountAtomic: "10000000000",
            decimals: 8,
            valueUsd: "10000",
            valuation: { ...valuation, priceUsd: "1" },
          },
        ],
      },
      parameters: { liquidationThresholdBps: 8000, maximumLtvBps: 7000 },
      provenance: [{ source: "contract-read" as const, blockHeight: 1, observedAt: "2026-09-04T00:00:00.000Z" }],
      confidence: { state: "verified" as const, score: 0.95, reasons: ["fixture multi-leg"] },
    };
    const summary = analyzePortfolio(
      {
        address: DEMO_ADDRESS,
        asOf: { stacksBlockHeight: 1, bitcoinBlockHeight: 1, observedAt: "2026-09-04T00:00:00.000Z" },
        positions: [position],
        warnings: [],
      },
      [],
      { allowFixtureEvidence: true },
    );
    expect(summary.totalAssetsUsd).toBe("150000");
    expect(summary.totalDebtUsd).toBe("30000");
    expect(summary.netWorthUsd).toBe("120000");
    expect(summary.scenarios[0]).toMatchObject({
      name: "BTC −10%",
      estimatedLossUsd: "15000",
      estimatedNetValueUsd: "105000",
      positionsAffected: 1,
    });
  });
});
