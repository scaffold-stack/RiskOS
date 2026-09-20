import { describe, expect, it } from "vitest";
import type { YieldMarket } from "../../adapters/src/index.js";
import { allocateYieldCapital } from "./index.js";

const TEST_NOW = new Date("2026-09-13T00:01:00.000Z");
const allocate = (
  capitalUsd: string,
  days: 30 | 90 | 365,
  markets: YieldMarket[],
  mode: "explore" | "recommend" = "recommend",
) => allocateYieldCapital(capitalUsd, days, markets, TEST_NOW, mode);

const market = (id: string, protocol: string, rate: number, tvlUsd: string | null = "1000000000"): YieldMarket => ({
  id,
  protocol,
  kind: protocol === "bitflow" ? "liquidity" : "lending",
  assets: id,
  annualizedRateBps: rate,
  rateLabel: protocol === "bitflow" ? "Fee APR" : "Supply APR",
  evidenceState: "verified",
  confidenceScore: 0.9,
  observedAtBlock: 10,
  observedAt: "2026-09-13T00:00:00.000Z",
  tvlUsd,
  independentRateEvidence: {
    source: `${id}-comparison`,
    observedAt: "2026-09-13T00:00:00.000Z",
    annualizedRateBps: rate,
    differenceBps: 0,
  },
  capacityEvidence: tvlUsd === null ? null : {
    source: `${id}-capacity`,
    observedAt: "2026-09-13T00:00:00.000Z",
    tvlUsd,
  },
  source: id,
  meaning: "test",
  eligibleForAllocation: true,
});

describe("automatic yield allocation", () => {
  it("maximizes rate subject to protocol and market concentration limits", () => {
    const result = allocate("1000000", 365, [
      market("zest-sbtc", "zest", 900),
      market("zest-stx", "zest", 700),
      market("bitflow-sbtc", "bitflow", 800, "50000000"),
    ]);
    expect(result.allocations.map((item) => [item.marketId, item.amountUsd])).toEqual([
      ["zest-sbtc", "400000.00"],
      ["bitflow-sbtc", "400000.00"],
      ["zest-stx", "200000.00"],
    ]);
    expect(result.unallocatedUsd).toBe("0.00");
    expect(result.projectedGrossEarningsUsd).toBe("82000.00");
  });

  it("never allocates to a market without an accepted current rate", () => {
    const unavailable = {
      ...market("missing", "granite", 500),
      annualizedRateBps: null,
      eligibleForAllocation: false,
    };
    const result = allocate("100", 30, [unavailable]);
    expect(result.allocations).toEqual([]);
    expect(result.unallocatedUsd).toBe("100.00");
  });

  it("rejects stale independent comparison and capacity evidence", () => {
    const staleReference = market("stale-reference", "zest", 500);
    staleReference.independentRateEvidence!.observedAt = "2026-09-12T22:59:59.000Z";
    staleReference.capacityEvidence!.observedAt = "2026-09-12T22:59:59.000Z";
    const result = allocate("1000", 30, [staleReference]);
    expect(result.allocations).toEqual([]);
    expect(result.markets[0]?.allocationExclusionReason).toContain("Independent evidence is stale");
  });

  it("rejects internally inconsistent independent rate or capacity claims", () => {
    const mismatchedRate = market("mismatched-rate", "zest", 500);
    mismatchedRate.independentRateEvidence = {
      ...mismatchedRate.independentRateEvidence!,
      annualizedRateBps: 450,
      differenceBps: 0,
    };
    const mismatchedCapacity = market("mismatched-capacity", "zest", 500, "1000.00");
    mismatchedCapacity.capacityEvidence = { ...mismatchedCapacity.capacityEvidence!, tvlUsd: "999.00" };
    const result = allocate("1000", 30, [mismatchedRate, mismatchedCapacity]);
    expect(result.allocations).toEqual([]);
    expect(result.markets.map((item) => item.allocationExclusionReason)).toEqual([
      "Independent rate comparison is missing, inconsistent, or outside the 50 bps tolerance.",
      "Deployable-capacity evidence is missing or does not match reported TVL.",
    ]);
  });

  it("fails closed on contradictory evidence and malformed LP capacity", () => {
    const contradictory = {
      ...market("contradictory", "zest", 500),
      evidenceState: "unavailable" as const,
      eligibleForAllocation: true,
    };
    const malformedLiquidity = {
      ...market("malformed", "bitflow", 900, "not-money"),
      eligibleForAllocation: true,
    };
    const nonFiniteRate = { ...market("non-finite", "zest", 500), annualizedRateBps: Infinity };
    const missingCapacity = { ...market("missing-capacity", "zest", 700), tvlUsd: null };
    const result = allocate("100", 30, [
      contradictory,
      malformedLiquidity,
      nonFiniteRate,
      missingCapacity,
    ]);
    expect(result.allocations).toEqual([]);
    expect(result.unallocatedUsd).toBe("100.00");
    expect(result.markets.every((item) => item.allocationExclusionReason !== null)).toBe(true);
  });

  it("uses APY compounding and applies reported-TVL capacity limits consistently", () => {
    const hermetica: YieldMarket = {
      ...market("hermetica-susdh", "hermetica", 800, "100000.00"),
      kind: "stacking",
      rateLabel: "Reward APY",
      evidenceState: "verified",
      confidenceScore: 0.9,
    };
    const result = allocate("1000", 30, [hermetica]);
    expect(result.allocations).toMatchObject([{
      amountUsd: "1000.00",
      annualizedRateBps: 800,
      rateLabel: "Reward APY",
      projectedGrossEarningsUsd: "6.35",
      confidenceScore: 0.9,
      reportedTvlCapacityUsd: "2000.00",
    }]);
    expect(result.unallocatedUsd).toBe("0.00");
    expect(result.weightedAnnualizedRateBps).toBe(800);

    const capacityLimited = allocate("1000", 30, [{
      ...hermetica,
      tvlUsd: "100.00",
      capacityEvidence: { ...hermetica.capacityEvidence!, tvlUsd: "100.00" },
    }]);
    expect(capacityLimited.allocations[0]?.amountUsd).toBe("2.00");
    expect(capacityLimited.unallocatedUsd).toBe("998.00");
  });

  it("ranks APR and APY by selected-period earnings instead of headline rate", () => {
    const rewardApy: YieldMarket = {
      ...market("reward-apy", "hermetica", 800),
      kind: "stacking",
      rateLabel: "Reward APY",
      evidenceState: "verified",
      confidenceScore: 0.9,
    };
    const supplyApr = market("supply-apr", "zest", 780);
    const result = allocate("1000", 30, [rewardApy, supplyApr]);
    expect(result.allocations.map((allocation) => allocation.marketId)).toEqual([
      "supply-apr",
      "reward-apy",
    ]);
  });

  it("never turns a provider-reported observation into a recommendation allocation", () => {
    const reported = {
      ...market("bitflow-provider-apr", "bitflow", 42_608, "367528.07"),
      evidenceState: "provider-reported" as const,
      confidenceScore: 0.7,
      observedAtBlock: null,
    };
    const result = allocate("1000000", 365, [reported]);
    expect(result.allocations).toEqual([]);
    expect(result.projectedGrossEarningsUsd).toBe("0.00");
    expect(result.unallocatedUsd).toBe("1000000.00");
    expect(result.markets[0]).toMatchObject({
      eligibleForAllocation: false,
      allocationExclusionReason:
        "Provider-reported rate is not independently corroborated; it cannot drive a recommendation allocation.",
    });
  });

  it("lets explore mode simulate provider-reported and unverified on-chain rates with honest labels", () => {
    const reported = {
      ...market("bitflow-provider-apr", "bitflow", 800, "1000000.00"),
      evidenceState: "provider-reported" as const,
      confidenceScore: 0.7,
      observedAtBlock: null,
      independentRateEvidence: null,
      capacityEvidence: {
        source: "bitflow-tvl",
        observedAt: "2026-09-13T00:00:00.000Z",
        tvlUsd: "1000000.00",
      },
    };
    const onChain = {
      ...market("zest-onchain", "zest", 500, null),
      independentRateEvidence: null,
      capacityEvidence: null,
      eligibleForAllocation: false,
    };
    const result = allocate("1000000", 365, [reported, onChain], "explore");
    expect(result.mode).toBe("explore");
    expect(result.allocations.map((item) => item.marketId)).toEqual([
      "bitflow-provider-apr",
      "zest-onchain",
    ]);
    expect(result.allocations[0]?.evidenceState).toBe("provider-reported");
    expect(result.projectedGrossEarningsUsd).not.toBe("0.00");
    expect(Number(result.allocatedUsd)).toBeGreaterThan(0);
    expect(result.allocations).toHaveLength(2);
  });

  it("excludes stale and materially future-dated evidence from allocation", () => {
    const stale = { ...market("stale", "zest", 900), observedAt: "2026-09-12T23:30:00.000Z" };
    const future = { ...market("future", "zest", 800), observedAt: "2026-09-13T00:01:31.000Z" };
    const result = allocate("1000", 30, [stale, future]);
    expect(result.allocations).toEqual([]);
    expect(result.markets.map((item) => item.allocationExclusionReason)).toEqual([
      "Rate evidence is stale (1860s old; maximum 1800s).",
      "Evidence timestamp is in the future.",
    ]);
  });

  it("rejects pathological capital inputs before performing an allocation", () => {
    expect(() => allocate("1000000000000.01", 30, [market("zest", "zest", 500)]))
      .toThrow("capitalUsd must not exceed 1000000000000");
  });
});
