import { describe, expect, it } from "vitest";
import type { PositionEnvelope } from "../../../../packages/domain/src/index.js";
import { buildYieldOpportunities, centsToUsd, projectGrossYield } from "./yieldStrategies.js";

const observedAt = "2026-09-13T08:00:00.000Z";
const envelope: PositionEnvelope = {
  address: "SP000000000000000000002Q6VF78",
  asOf: { stacksBlockHeight: 900, bitcoinBlockHeight: 800, observedAt },
  warnings: [],
  positions: [
    {
      id: "zest:supply:sbtc",
      type: "supply",
      protocol: { id: "zest", version: "1", contract: "SP.contract" },
      asset: { asset: "sBTC", amountAtomic: "100000000", decimals: 8, valueUsd: "100000" },
      rates: { supplyAprBps: 500, utilizationBps: 7000, reserveFactorBps: 1000, observedAtBlock: 900 },
      earnings: {
        annualizedRateBps: 500,
        rateKind: "supply-apr",
        earnedToDateUsd: null,
        observedAtBlock: 900,
        meaning: "Verified on-chain rate",
        provenance: [{ source: "contract-read", blockHeight: 900, observedAt }],
        confidence: { state: "verified", score: 0.92, reasons: [] },
      },
      provenance: [{ source: "contract-read", blockHeight: 900, observedAt }],
      confidence: { state: "verified", score: 0.92, reasons: [] },
    },
    {
      id: "bitflow:lp:sbtc-usdcx",
      type: "liquidity",
      protocol: { id: "bitflow", version: "1", contract: "SP.pool" },
      token0: { asset: "sBTC", amountAtomic: "50000000", decimals: 8, valueUsd: "50000" },
      token1: { asset: "USDCx", amountAtomic: "50000000000", decimals: 6, valueUsd: "50000" },
      lowerPrice: "70000",
      upperPrice: "90000",
      currentPrice: "80000",
      exitSlippageBps: null,
      earnings: {
        annualizedRateBps: 1200,
        rateKind: "provider-apy",
        earnedToDateUsd: null,
        observedAtBlock: 900,
        meaning: "Provider-reported APY",
        provenance: [{ source: "quote", blockHeight: 900, observedAt }],
        confidence: { state: "estimated", score: 0.6, reasons: [] },
      },
      provenance: [{ source: "quote", blockHeight: 900, observedAt }],
      confidence: { state: "estimated", score: 0.6, reasons: [] },
    },
  ],
};

describe("yield strategy evidence gate", () => {
  it("ranks verified rates and keeps a higher unverified APY out of the ranking", () => {
    const opportunities = buildYieldOpportunities(envelope);
    expect(opportunities[0]).toMatchObject({ protocol: "zest", rankable: true, annualizedRateBps: 500 });
    expect(opportunities[1]).toMatchObject({ protocol: "bitflow", rankable: false, annualizedRateBps: 1200 });
    expect(opportunities[1]?.exclusionReason).toContain("not independently verified");
  });

  it("projects gross simple yield with integer cents", () => {
    const projection = projectGrossYield("1000000", 500, 30);
    expect(centsToUsd(projection!.grossEarningsCents)).toBe("4109.58");
    expect(centsToUsd(projection!.endingValueCents)).toBe("1004109.58");
  });

  it("rejects invalid capital instead of coercing it", () => {
    expect(projectGrossYield("1,000,000.999", 500, 365)).toBeNull();
    expect(projectGrossYield("-100", 500, 365)).toBeNull();
  });
});
