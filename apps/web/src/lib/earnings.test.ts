import { describe, expect, it } from "vitest";
import type { Position } from "../../../../packages/domain/src/index.js";
import { debtProjection, simpleInterestAtomic, yieldProjection } from "./earnings.js";

const evidence = {
  provenance: [{ source: "contract-read" as const, observedAt: "2026-09-06T00:00:00.000Z" }],
  confidence: { state: "verified" as const, score: 0.9, reasons: [] },
};

describe("earnings presentation", () => {
  it("projects supplied-token interest from the evidenced APR", () => {
    expect(simpleInterestAtomic("1000000000", 365, 30)).toBe("3000000");
    const position: Position = {
      ...evidence,
      id: "supply",
      type: "supply",
      protocol: { id: "zest", version: "v2", contract: "SP.contract" },
      asset: { asset: "STX", amountAtomic: "1000000000", decimals: 6, valueUsd: "260" },
      rates: { supplyAprBps: 365, utilizationBps: 5000, reserveFactorBps: 1000, observedAtBlock: 10 },
    };
    expect(yieldProjection(position)).toMatchObject({
      annualRateLabel: "3.65% supply APR",
      projected30dAsset: "3 STX",
      projected30dUsd: "0.78",
      status: "earning",
    });
  });

  it("does not project LP earnings while the position is out of range", () => {
    const position: Position = {
      ...evidence,
      id: "lp",
      type: "liquidity",
      protocol: { id: "bitflow", version: "v1", contract: "SP.pool" },
      token0: { asset: "sBTC", amountAtomic: "100000000", decimals: 8, valueUsd: "80000" },
      token1: { asset: "USDCx", amountAtomic: "10000000000", decimals: 6, valueUsd: "10000" },
      lowerPrice: "70000",
      upperPrice: "79000",
      currentPrice: "80000",
      exitSlippageBps: null,
      earnings: {
        annualizedRateBps: 4089,
        rateKind: "provider-apy",
        earnedToDateUsd: null,
        observedAtBlock: 10,
        meaning: "provider rate",
      },
    };
    expect(yieldProjection(position)).toMatchObject({
      annualRateLabel: "40.89% reported APY",
      projected30dUsd: null,
      status: "paused",
    });
  });

  it("uses the canonical 30-day debt projection", () => {
    const position = {
      ...evidence,
      id: "loan",
      type: "lending" as const,
      protocol: { id: "zest", version: "v2", contract: "SP.contract" },
      collateral: { asset: "sBTC", amountAtomic: "100000000", decimals: 8, valueUsd: "80000" },
      debt: { asset: "USDCx", amountAtomic: "50000000000", decimals: 6, valueUsd: "50000" },
      parameters: { liquidationThresholdBps: 7000, maximumLtvBps: 6000 },
      rates: {
        borrowAprBps: 500,
        supplyAprBps: 0,
        utilizationBps: 5000,
        reserveFactorBps: 1000,
        observedAtBlock: 10,
        debtProjections: [
          { days: 7 as const, amountAtomic: "50050000000", assumption: "constant" },
          { days: 30 as const, amountAtomic: "50200000000", assumption: "constant" },
          { days: 90 as const, amountAtomic: "50600000000", assumption: "constant" },
        ],
      },
    };
    expect(debtProjection(position)).toEqual({
      total: "50200 USDCx",
      interest: "200 USDCx",
      assumption: "constant",
    });
  });
});
