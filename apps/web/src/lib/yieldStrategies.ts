import type {
  LendingPosition,
  LendingSupplyPosition,
  LiquidityPosition,
  PositionEnvelope,
} from "../../../../packages/domain/src/index.js";

export type YieldStrategyKind = "lending" | "liquidity";

export interface YieldOpportunity {
  id: string;
  protocol: string;
  kind: YieldStrategyKind;
  assets: string;
  annualizedRateBps: number | null;
  rateLabel: "Supply APR" | "Provider APY";
  rankable: boolean;
  confidenceScore: number;
  confidenceState: "verified" | "estimated" | "degraded" | "unsupported";
  observedAtBlock: number | null;
  meaning: string;
  exclusionReason: string | null;
}

export interface YieldProjection {
  principalCents: bigint;
  grossEarningsCents: bigint;
  endingValueCents: bigint;
  days: 30 | 90 | 365;
}

export function buildYieldOpportunities(envelope: PositionEnvelope): YieldOpportunity[] {
  const candidates = envelope.positions.flatMap((position): YieldOpportunity[] => {
    if (position.type === "supply") return [fromSupply(position)];
    if (position.type === "liquidity") return [fromLiquidity(position)];
    if (position.type === "lending" && position.rates) return [fromLendingMarket(position)];
    return [];
  });
  const deduplicated = new Map<string, YieldOpportunity>();
  for (const candidate of candidates) {
    const key = `${candidate.protocol}:${candidate.kind}:${candidate.assets}`.toLowerCase();
    const current = deduplicated.get(key);
    if (
      !current ||
      Number(candidate.rankable) > Number(current.rankable) ||
      candidate.confidenceScore > current.confidenceScore
    ) {
      deduplicated.set(key, candidate);
    }
  }
  return [...deduplicated.values()].sort((left, right) => {
    if (left.rankable !== right.rankable) return left.rankable ? -1 : 1;
    return (right.annualizedRateBps ?? -1) - (left.annualizedRateBps ?? -1);
  });
}

export function projectGrossYield(
  principalUsd: string,
  annualizedRateBps: number,
  days: 30 | 90 | 365,
): YieldProjection | null {
  const principalCents = usdToCents(principalUsd);
  if (principalCents === null || principalCents <= 0n || !Number.isSafeInteger(annualizedRateBps))
    return null;
  const grossEarningsCents = (principalCents * BigInt(annualizedRateBps) * BigInt(days)) / (10_000n * 365n);
  return {
    principalCents,
    grossEarningsCents,
    endingValueCents: principalCents + grossEarningsCents,
    days,
  };
}

export function centsToUsd(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function usdToCents(value: string): bigint | null {
  const normalized = value.trim().replaceAll(",", "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function fromSupply(position: LendingSupplyPosition): YieldOpportunity {
  const rate = position.earnings?.annualizedRateBps ?? position.rates?.supplyAprBps ?? null;
  const confidence = position.earnings?.confidence ?? position.confidence;
  const observedAtBlock = position.earnings?.observedAtBlock ?? position.rates?.observedAtBlock ?? null;
  const rankable = rate !== null && confidence.state === "verified" && confidence.score >= 0.8;
  return {
    id: `supply:${position.protocol.id}:${position.asset.asset}`,
    protocol: position.protocol.id,
    kind: "lending",
    assets: position.asset.asset,
    annualizedRateBps: rate,
    rateLabel: "Supply APR",
    rankable,
    confidenceScore: confidence.score,
    confidenceState: confidence.state,
    observedAtBlock,
    meaning:
      position.earnings?.meaning ??
      "Current supply rate from the observed lending market; it can change with utilization.",
    exclusionReason: exclusionReason(rate, confidence.state, confidence.score),
  };
}

function fromLendingMarket(position: LendingPosition): YieldOpportunity {
  const rate = position.rates!.supplyAprBps;
  const rankable = position.confidence.state === "verified" && position.confidence.score >= 0.8;
  return {
    id: `market:${position.protocol.id}:${position.debt.asset}`,
    protocol: position.protocol.id,
    kind: "lending",
    assets: position.debt.asset,
    annualizedRateBps: rate,
    rateLabel: "Supply APR",
    rankable,
    confidenceScore: position.confidence.score,
    confidenceState: position.confidence.state,
    observedAtBlock: position.rates!.observedAtBlock,
    meaning:
      "Supply-side APR reconstructed from the same market's verified borrow rate, utilization, and reserve factor.",
    exclusionReason: exclusionReason(rate, position.confidence.state, position.confidence.score),
  };
}

function fromLiquidity(position: LiquidityPosition): YieldOpportunity {
  const rate = position.earnings?.annualizedRateBps ?? null;
  const confidence = position.earnings?.confidence ?? position.confidence;
  const rankable = rate !== null && confidence.state === "verified" && confidence.score >= 0.8;
  return {
    id: `liquidity:${position.protocol.id}:${position.token0.asset}-${position.token1.asset}`,
    protocol: position.protocol.id,
    kind: "liquidity",
    assets: `${position.token0.asset} / ${position.token1.asset}`,
    annualizedRateBps: rate,
    rateLabel: "Provider APY",
    rankable,
    confidenceScore: confidence.score,
    confidenceState: confidence.state,
    observedAtBlock: position.earnings?.observedAtBlock ?? null,
    meaning:
      position.earnings?.meaning ??
      "No independently reconstructed fee and incentive rate is available for this liquidity position.",
    exclusionReason: exclusionReason(rate, confidence.state, confidence.score),
  };
}

function exclusionReason(rate: number | null, state: string, score: number): string | null {
  if (rate === null) return "No current annualized rate is available.";
  if (state !== "verified") return `Rate evidence is ${state}, not independently verified.`;
  if (score < 0.8) return `Evidence confidence is ${Math.round(score * 100)}%, below the 80% ranking gate.`;
  return null;
}
