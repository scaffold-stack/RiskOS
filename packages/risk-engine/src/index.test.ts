import { describe, expect, it } from "vitest";
import { DEMO_ADDRESS, FixtureBitflowAdapter, FixtureZestAdapter } from "../../adapters/src/index.js";
import { currentCollateralPriceUsd, evaluateRisks, lendingHealthFactor, lendingLiquidationPriceUsd } from "./index.js";

describe("risk engine", () => {
  it("calculates protocol-threshold lending health deterministically", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0];
    expect(position?.type).toBe("lending");
    if (!position || position.type !== "lending") throw new Error("Fixture missing");
    expect(lendingHealthFactor(position)).toBe("1.0666");
    const finding = evaluateRisks([position], new Date("2026-09-03T15:00:00Z"))[0];
    expect(finding).toMatchObject({ severity: "high", category: "liquidation", score: 73 });
    expect(currentCollateralPriceUsd(position)).toBe("100000");
    expect(lendingLiquidationPriceUsd(position)).toBe("93750");
    expect(finding?.meaning).toContain("health factor");
    expect(finding?.plainMetrics.some((metric) => metric.label === "Health factor")).toBe(true);
    expect(finding?.scenarios[0]).toMatchObject({ name: "Collateral -10%", result: "0.9599" });
    expect(finding?.scenarios[2]).toMatchObject({ name: "Collateral -30%", result: "0.7466" });
  });

  it("flags executable LP exit slippage above one percent", async () => {
    const positions = await new FixtureBitflowAdapter().discover(DEMO_ADDRESS);
    expect(evaluateRisks(positions)[0]).toMatchObject({
      severity: "medium",
      category: "liquidity",
      score: 45,
      whyItMatters: expect.any(String),
    });
  });

  it("fails closed when an LP exit quote is unavailable", async () => {
    const position = (await new FixtureBitflowAdapter().discover(DEMO_ADDRESS))[0];
    if (!position || position.type !== "liquidity") throw new Error("Fixture missing");
    const finding = evaluateRisks([{ ...position, exitSlippageBps: null }])[0];
    expect(finding).toMatchObject({
      severity: "medium",
      score: 35,
      title: "Exit liquidity quote is unavailable",
      confidence: { state: "degraded", score: 0.65 },
      recommendedActions: [],
    });
  });

  it("keeps a healthy lending score, severity, and actions aligned", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0];
    if (!position || position.type !== "lending") throw new Error("Fixture missing");
    const healthy = {
      ...position,
      debt: { ...position.debt, valueUsd: "35359.12", amountAtomic: "35359120000" },
    };
    const finding = evaluateRisks([healthy])[0];
    expect(finding?.severity).toBe("low");
    expect(finding?.score).toBeLessThan(30);
    expect(finding?.recommendedActions).toEqual([]);
  });

  it("aggregates multi-leg collateral and debt while withholding a single liquidation price", () => {
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
          { asset: "sBTC", amountAtomic: "100000000", decimals: 8, valueUsd: "100000", valuation },
          { asset: "stBTC", amountAtomic: "50000000", decimals: 8, valueUsd: "50000", valuation },
        ],
        debt: [
          {
            asset: "USDCx",
            amountAtomic: "20000000000",
            decimals: 6,
            valueUsd: "20000",
            valuation: { ...valuation, priceUsd: "1" },
          },
        ],
      },
      parameters: { liquidationThresholdBps: 8000, maximumLtvBps: 7000 },
      provenance: [{ source: "contract-read" as const, blockHeight: 1, observedAt: "2026-09-04T00:00:00.000Z" }],
      confidence: { state: "verified" as const, score: 0.95, reasons: ["fixture multi-leg"] },
    };
    expect(lendingHealthFactor(position)).toBe("6");
    expect(lendingLiquidationPriceUsd(position)).toBeNull();
    expect(currentCollateralPriceUsd(position)).toBeNull();
    const finding = evaluateRisks([position], new Date("2026-09-03T15:00:00Z"))[0];
    expect(finding?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "collateralValueUsd", value: "150000" }),
        expect.objectContaining({ metric: "debtValueUsd", value: "20000" }),
        expect.objectContaining({ metric: "estimatedLiquidationPriceUsd", value: "unknown" }),
      ]),
    );
  });
});
