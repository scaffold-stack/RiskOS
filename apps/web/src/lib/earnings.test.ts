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
      earnings: {
        annualizedRateBps: 365,
        rateKind: "supply-apr",
        earnedToDateUsd: null,
        observedAtBlock: 10,
        meaning: "Contract-derived supply rate",
        provenance: [{ source: "contract-read", blockHeight: 10, observedAt: "2026-09-06T00:00:00.000Z" }],
        confidence: { state: "verified", score: 0.9, reasons: ["Pinned contract reads"] },
      },
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
        provenance: [{ source: "quote", blockHeight: 10, observedAt: "2026-09-06T00:00:00.000Z" }],
        confidence: {
          state: "estimated",
          score: 0.6,
          reasons: ["Provider-reported rate has not been reconstructed from canonical events"],
        },
      },
    };
    expect(yieldProjection(position)).toMatchObject({
      annualRateLabel: "40.89% provider-reported APY",
      projected30dUsd: null,
      status: "paused",
    });
  });

  it("projects an explicitly labeled official provider APY when confidence clears the gate", () => {
    const position: Position = {
      ...evidence,
      id: "hermetica-supply",
      type: "supply",
      protocol: { id: "hermetica", version: "v1", contract: "SP.contract" },
      asset: { asset: "sUSDh", amountAtomic: "1000000000", decimals: 6, valueUsd: "1000" },
      earnings: {
        annualizedRateBps: 800,
        rateKind: "provider-apy",
        earnedToDateUsd: null,
        observedAtBlock: null,
        meaning: "Official protocol 7-day realized APY; held constant for the projection.",
        provenance: [{ source: "quote", observedAt: "2026-09-06T00:00:00.000Z" }],
        confidence: { state: "estimated", score: 0.78, reasons: ["Official protocol API"] },
      },
    };
    expect(yieldProjection(position)).toMatchObject({
      annualRateLabel: "8.00% provider-reported APY",
      projected30dUsd: "6.35",
      status: "reported",
    });
  });

  it("labels a verified zero supply APR as an idle vault instead of a missing rate", () => {
    const position: Position = {
      ...evidence,
      id: "zest-idle-supply",
      type: "supply",
      protocol: { id: "zest", version: "v2", contract: "SP.vault" },
      asset: { asset: "zstSTXbtc", amountAtomic: "1000000", decimals: 6, valueUsd: "100" },
      earnings: {
        annualizedRateBps: 0,
        rateKind: "supply-apr",
        earnedToDateUsd: null,
        observedAtBlock: 9_000_000,
        meaning: "Verified idle vault.",
        provenance: [
          { source: "contract-read", blockHeight: 9_000_000, observedAt: "2026-09-19T00:00:00.000Z" },
        ],
        confidence: { state: "verified", score: 0.92, reasons: ["Pinned vault reads"] },
      },
    };
    expect(yieldProjection(position)).toMatchObject({
      annualRateLabel: "Idle vault · no borrowers",
      projected30dUsd: null,
      status: "idle",
    });
  });

  it("shows a verified strategy-vault loss instead of hiding it as an unavailable rate", () => {
    const position: Position = {
      ...evidence,
      id: "zvstbtc-strategy",
      type: "supply",
      protocol: { id: "zest", version: "v2", contract: "SP.strategy" },
      asset: { asset: "zvstBTC", amountAtomic: "100000000", decimals: 8, valueUsd: "1000" },
      earnings: {
        annualizedRateBps: -3,
        rateKind: "realized-apy",
        earnedToDateUsd: null,
        observedAtBlock: 8_999_999,
        meaning: "Canonical strategy share-price return since the first successful deposit.",
        provenance: [
          { source: "contract-read", blockHeight: 8_999_999, observedAt: "2026-09-16T00:00:00.000Z" },
        ],
        confidence: { state: "verified", score: 0.92, reasons: ["Pinned engine share price"] },
      },
    };

    expect(yieldProjection(position)).toMatchObject({
      annualRateLabel: "-0.03% realized APY",
      projected30dUsd: "-0.02",
      projected30dAsset: null,
      status: "losing",
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
      total: "50,200 USDCx",
      interest: "200 USDCx",
      assumption: "constant",
    });
  });
});
