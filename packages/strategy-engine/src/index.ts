import type { YieldMarket } from "../../adapters/src/index.js";

export type YieldAllocationMode = "explore" | "recommend";

export interface YieldAllocation {
  marketId: string;
  protocol: string;
  kind: YieldMarket["kind"];
  assets: string;
  amountUsd: string;
  shareBps: number;
  annualizedRateBps: number;
  rateLabel: YieldMarket["rateLabel"];
  projectedGrossEarningsUsd: string;
  evidenceState: YieldMarket["evidenceState"];
  confidenceScore: number;
  observedAt: string;
  observedAtBlock: number | null;
  reportedTvlUsd: string | null;
  reportedTvlCapacityUsd: string | null;
  source: string;
  independentRateEvidence: YieldMarket["independentRateEvidence"];
  capacityEvidence: YieldMarket["capacityEvidence"];
}

export interface EvaluatedYieldMarket extends YieldMarket {
  allocationExclusionReason: string | null;
}

export interface YieldAllocationPlan {
  capitalUsd: string;
  days: 30 | 90 | 365;
  mode: YieldAllocationMode;
  allocatedUsd: string;
  unallocatedUsd: string;
  projectedGrossEarningsUsd: string;
  weightedAnnualizedRateBps: number;
  generatedAt: string;
  evidenceAsOf: string | null;
  allocations: YieldAllocation[];
  markets: EvaluatedYieldMarket[];
  policy: {
    objective: string;
    maximumProtocolShareBps: number;
    maximumMarketShareBps: number;
    maximumPoolTvlShareBps: number;
  };
  warnings: string[];
}

const HUNDRED_PERCENT = 10_000;
const REPORTED_TVL_LIMIT_BPS = 200;
const MAX_INDEPENDENT_RATE_DIFFERENCE_BPS = 50;
export const MAX_YIELD_SIMULATION_USD = 1_000_000_000_000n;
/** Catalog discovery can take minutes; keep primary rates usable afterward. */
export const MAX_YIELD_EVIDENCE_AGE_SECONDS = 1_800;
export const MAX_YIELD_EXPLORE_EVIDENCE_AGE_SECONDS = 3_600;
export const MAX_YIELD_REFERENCE_AGE_SECONDS = 3_600;
const FUTURE_CLOCK_SKEW_SECONDS = 30;

export function allocateYieldCapital(
  capitalUsd: string,
  days: 30 | 90 | 365,
  markets: YieldMarket[],
  at = new Date(),
  mode: YieldAllocationMode = "recommend",
): YieldAllocationPlan {
  const capitalCents = parseUsdCents(capitalUsd);
  if (capitalCents === null || capitalCents <= 0n)
    throw new Error("capitalUsd must be a positive amount with at most two decimal places");
  if (capitalCents > MAX_YIELD_SIMULATION_USD * 100n)
    throw new Error(`capitalUsd must not exceed ${MAX_YIELD_SIMULATION_USD.toString()}`);
  if (!Number.isFinite(at.getTime())) throw new Error("allocation time must be a valid date");
  const evaluatedMarkets: EvaluatedYieldMarket[] = markets.map((market) => {
    const allocationExclusionReason = allocationGateFailure(market, at, mode);
    return {
      ...market,
      eligibleForAllocation: allocationExclusionReason === null,
      allocationExclusionReason,
    };
  });
  const eligible = evaluatedMarkets
    .filter((market) => market.eligibleForAllocation)
    .sort((a, b) => {
      const left = periodReturnPartsPerTrillion(a, days);
      const right = periodReturnPartsPerTrillion(b, days);
      return left === right ? b.confidenceScore - a.confidenceScore : left > right ? -1 : 1;
    });
  const protocolCount = new Set(eligible.map((market) => market.protocol)).size;
  const protocolCapBps = protocolCount >= 2 ? 6_000 : HUNDRED_PERCENT;
  const marketCapBps = eligible.length >= 3 ? 4_000 : HUNDRED_PERCENT;
  const protocolUsed = new Map<string, bigint>();
  const allocations: YieldAllocation[] = [];
  let remaining = capitalCents;
  let projectedTotal = 0n;
  let weightedRateNumerator = 0n;

  for (const market of eligible) {
    if (remaining === 0n) break;
    const protocolLimit = (capitalCents * BigInt(protocolCapBps)) / 10_000n;
    const protocolRemaining = protocolLimit - (protocolUsed.get(market.protocol) ?? 0n);
    const marketLimit = (capitalCents * BigInt(marketCapBps)) / 10_000n;
    const reportedTvlLimit = market.tvlUsd === null
      ? capitalCents
      : (parseUsdCents(market.tvlUsd)! * BigInt(REPORTED_TVL_LIMIT_BPS)) / 10_000n;
    const amount = minimum(remaining, protocolRemaining, marketLimit, reportedTvlLimit);
    if (amount <= 0n) continue;
    const earnings = projectedEarnings(amount, market, days);
    allocations.push({
      marketId: market.id,
      protocol: market.protocol,
      kind: market.kind,
      assets: market.assets,
      amountUsd: centsToUsd(amount),
      shareBps: Number((amount * 10_000n) / capitalCents),
      annualizedRateBps: market.annualizedRateBps!,
      rateLabel: market.rateLabel,
      projectedGrossEarningsUsd: centsToUsd(earnings),
      evidenceState: market.evidenceState,
      confidenceScore: market.confidenceScore,
      observedAt: market.observedAt,
      observedAtBlock: market.observedAtBlock,
      reportedTvlUsd: market.tvlUsd,
      reportedTvlCapacityUsd: market.tvlUsd === null ? null : centsToUsd(reportedTvlLimit),
      source: market.source,
      independentRateEvidence: market.independentRateEvidence,
      capacityEvidence: market.capacityEvidence,
    });
    remaining -= amount;
    projectedTotal += earnings;
    weightedRateNumerator += amount * BigInt(market.annualizedRateBps!);
    protocolUsed.set(market.protocol, (protocolUsed.get(market.protocol) ?? 0n) + amount);
  }

  const allocated = capitalCents - remaining;
  const evidenceTimes = allocations.flatMap((allocation) => {
    const times = [Date.parse(allocation.observedAt)];
    if (allocation.independentRateEvidence)
      times.push(Date.parse(allocation.independentRateEvidence.observedAt));
    if (allocation.capacityEvidence) times.push(Date.parse(allocation.capacityEvidence.observedAt));
    return times.filter((value) => Number.isFinite(value));
  });
  return {
    capitalUsd: centsToUsd(capitalCents),
    days,
    mode,
    allocatedUsd: centsToUsd(allocated),
    unallocatedUsd: centsToUsd(remaining),
    projectedGrossEarningsUsd: centsToUsd(projectedTotal),
    weightedAnnualizedRateBps:
      allocated === 0n ? 0 : Number(weightedRateNumerator / allocated),
    generatedAt: at.toISOString(),
    evidenceAsOf: evidenceTimes.length === 0 ? null : new Date(Math.min(...evidenceTimes)).toISOString(),
    allocations,
    markets: evaluatedMarkets,
    policy: {
      objective:
        mode === "explore"
          ? "Explore current allowlisted rates with honest evidence labels. Provider-reported and unverified-on-chain rates may receive simulated capital; this is not an executable recommendation."
          : "Maximize projected gross earnings using independently corroborated rates, subject to deterministic concentration and reported-TVL capacity limits.",
      maximumProtocolShareBps: protocolCapBps,
      maximumMarketShareBps: marketCapBps,
      maximumPoolTvlShareBps: REPORTED_TVL_LIMIT_BPS,
    },
    warnings:
      mode === "explore"
        ? [
            "Explore mode shows evidence-labeled simulations. It is not a signed or executable allocation.",
            "Rates are held constant for comparison and are not forecasts.",
            "APR projections use simple interest; Reward APY projections use the equivalent compounded period return.",
            "Provider-reported rates are labeled as such and can change quickly.",
            "Swap, entry, exit, network, impermanent-loss, incentive and tax effects are excluded unless independently quoted.",
          ]
        : [
            "Rates are held constant for comparison and are not forecasts.",
            "APR projections use simple interest; Reward APY projections use the equivalent compounded period return.",
            "Provider-reported rates remain visible but cannot drive recommendation allocations without independent corroboration.",
            "Unallocated capital remains idle when verified capacity or concentration limits prevent a safe allocation.",
            "Swap, entry, exit, network, impermanent-loss, incentive and tax effects are excluded unless independently quoted.",
          ],
  };
}

function allocationGateFailure(
  market: YieldMarket,
  at: Date,
  mode: YieldAllocationMode,
): string | null {
  if (market.annualizedRateBps === null) return "No current annualized rate is available.";
  if (market.annualizedRateBps === 0) return `Current ${market.rateLabel} is 0.00%.`;
  if (
    !Number.isSafeInteger(market.annualizedRateBps) ||
    market.annualizedRateBps < 0 ||
    market.annualizedRateBps > 100_000 ||
    !Number.isFinite(market.confidenceScore) ||
    market.confidenceScore < 0 ||
    market.confidenceScore > 1
  ) return "Rate or confidence evidence is outside accepted bounds.";
  const observedAtMs = Date.parse(market.observedAt);
  if (!Number.isFinite(observedAtMs)) return "Evidence timestamp is invalid.";
  const ageSeconds = (at.getTime() - observedAtMs) / 1_000;
  if (ageSeconds < -FUTURE_CLOCK_SKEW_SECONDS) return "Evidence timestamp is in the future.";
  const maxPrimaryAge =
    mode === "explore" ? MAX_YIELD_EXPLORE_EVIDENCE_AGE_SECONDS : MAX_YIELD_EVIDENCE_AGE_SECONDS;
  if (ageSeconds > maxPrimaryAge)
    return `Rate evidence is stale (${Math.floor(ageSeconds)}s old; maximum ${maxPrimaryAge}s).`;

  if (mode === "explore") return exploreGateFailure(market);
  return recommendGateFailure(market, at);
}

function exploreGateFailure(market: YieldMarket): string | null {
  if (market.evidenceState === "unavailable") return "Rate evidence is unavailable.";
  if (market.evidenceState === "verified" && market.confidenceScore < 0.7)
    return "Verified evidence confidence is below 70%.";
  if (market.evidenceState === "provider-reported" && market.confidenceScore < 0.5)
    return "Provider evidence confidence is below 50%.";
  if (market.tvlUsd !== null) {
    const tvlCents = parseUsdCents(market.tvlUsd);
    if (tvlCents === null || tvlCents <= 0n) return "Reported TVL is zero or malformed.";
  }
  return null;
}

function recommendGateFailure(market: YieldMarket, at: Date): string | null {
  if (market.evidenceState === "verified") {
    if (market.confidenceScore < 0.8) return "Verified evidence confidence is below 80%.";
    if (market.observedAtBlock === null) return "Verified evidence has no pinned Stacks block.";
    if (market.independentRateEvidence === null)
      return "The on-chain rate has no fresh, independently matched comparison evidence.";
    const comparison = market.independentRateEvidence;
    if (
      !comparison.source ||
      comparison.source === market.source ||
      !Number.isSafeInteger(comparison.annualizedRateBps) ||
      comparison.annualizedRateBps < 0 ||
      Math.abs(market.annualizedRateBps! - comparison.annualizedRateBps) !== comparison.differenceBps ||
      comparison.differenceBps > MAX_INDEPENDENT_RATE_DIFFERENCE_BPS
    ) return `Independent rate comparison is missing, inconsistent, or outside the ${MAX_INDEPENDENT_RATE_DIFFERENCE_BPS} bps tolerance.`;
  } else if (market.evidenceState === "provider-reported") {
    return "Provider-reported rate is not independently corroborated; it cannot drive a recommendation allocation.";
  } else {
    return "Rate evidence is unavailable.";
  }
  if (!market.eligibleForAllocation) return market.meaning || "Market is not eligible for allocation.";
  if (market.tvlUsd === null)
    return "Current deployable-capacity evidence is unavailable; a rate alone is not enough to recommend an amount.";
  const tvlCents = parseUsdCents(market.tvlUsd);
  if (tvlCents === null || tvlCents <= 0n) return "Reported TVL is zero or malformed.";
  if (
    market.capacityEvidence === null ||
    !market.capacityEvidence.source ||
    market.capacityEvidence.source === market.source ||
    market.capacityEvidence.tvlUsd !== market.tvlUsd
  )
    return "Deployable-capacity evidence is missing or does not match reported TVL.";
  for (const evidence of [market.independentRateEvidence!, market.capacityEvidence]) {
    const evidenceAt = Date.parse(evidence.observedAt);
    if (!Number.isFinite(evidenceAt)) return "Independent evidence timestamp is invalid.";
    const evidenceAgeSeconds = (at.getTime() - evidenceAt) / 1_000;
    if (evidenceAgeSeconds < -FUTURE_CLOCK_SKEW_SECONDS) return "Independent evidence timestamp is in the future.";
    if (evidenceAgeSeconds > MAX_YIELD_REFERENCE_AGE_SECONDS)
      return `Independent evidence is stale (${Math.floor(evidenceAgeSeconds)}s old; maximum ${MAX_YIELD_REFERENCE_AGE_SECONDS}s).`;
  }
  return null;
}

function projectedEarnings(amountCents: bigint, market: YieldMarket, days: 30 | 90 | 365): bigint {
  return divideRounded(amountCents * periodReturnPartsPerTrillion(market, days), 1_000_000_000_000n);
}

function periodReturnPartsPerTrillion(market: YieldMarket, days: 30 | 90 | 365): bigint {
  if (market.rateLabel !== "Reward APY") {
    return divideRounded(
      BigInt(market.annualizedRateBps!) * BigInt(days) * 1_000_000_000_000n,
      10_000n * 365n,
    );
  }
  const annualRate = market.annualizedRateBps! / 10_000;
  return BigInt(Math.round(((1 + annualRate) ** (days / 365) - 1) * 1_000_000_000_000));
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function parseUsdCents(value: string): bigint | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function centsToUsd(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function minimum(...values: bigint[]): bigint {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}
