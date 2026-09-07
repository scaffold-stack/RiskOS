import type { LendingPosition, Position } from "../../../../packages/domain/src/index.js";
import { humanAmount } from "./portfolio.js";

const DAYS_PER_YEAR = 365;

export interface YieldProjection {
  annualRateLabel: string;
  earnedToDateUsd: string | null;
  projected30dUsd: string | null;
  projected30dAsset: string | null;
  status: "earning" | "paused" | "unavailable";
  meaning: string;
}

export function yieldProjection(position: Position): YieldProjection | null {
  if (position.type !== "supply" && position.type !== "liquidity") return null;
  const annualizedRateBps =
    position.earnings?.annualizedRateBps ??
    (position.type === "supply" ? (position.rates?.supplyAprBps ?? null) : null);
  const rateKind =
    position.earnings?.rateKind ?? (position.type === "supply" ? "supply-apr" : "provider-apy");
  const inRange =
    position.type !== "liquidity" ||
    (Number(position.currentPrice) >= Number(position.lowerPrice) &&
      Number(position.currentPrice) <= Number(position.upperPrice));
  const status = annualizedRateBps == null ? "unavailable" : inRange ? "earning" : "paused";
  let projected30dUsd: string | null = null;
  let projected30dAsset: string | null = null;

  if (annualizedRateBps != null && inRange) {
    if (position.type === "supply") {
      const projectedAtomic = simpleInterestAtomic(position.asset.amountAtomic, annualizedRateBps, 30);
      projected30dAsset = `${humanAmount(projectedAtomic, position.asset.decimals, position.asset.decimals)} ${position.asset.asset}`;
      projected30dUsd = simpleInterestUsd(position.asset.valueUsd, annualizedRateBps, 30);
    } else {
      const valueUsd = addUsd(position.token0.valueUsd, position.token1.valueUsd);
      projected30dUsd = apyProjectionUsd(valueUsd, annualizedRateBps, 30);
    }
  }

  return {
    annualRateLabel:
      annualizedRateBps == null
        ? "Rate unavailable"
        : `${(annualizedRateBps / 100).toFixed(2)}% ${rateKind === "supply-apr" ? "supply APR" : "reported APY"}`,
    earnedToDateUsd: position.earnings?.earnedToDateUsd ?? null,
    projected30dUsd,
    projected30dAsset,
    status,
    meaning:
      position.earnings?.meaning ??
      "A historical principal checkpoint is required before earned-to-date yield can be calculated.",
  };
}

export function debtProjection(position: LendingPosition) {
  const currentAtomic = BigInt(position.debt.amountAtomic);
  const projection = position.rates?.debtProjections.find((item) => item.days === 30);
  if (!projection) return null;
  const projectedAtomic = BigInt(projection.amountAtomic);
  const interestAtomic = projectedAtomic > currentAtomic ? projectedAtomic - currentAtomic : 0n;
  return {
    total: `${humanAmount(projectedAtomic.toString(), position.debt.decimals, position.debt.decimals)} ${position.debt.asset}`,
    interest: `${humanAmount(interestAtomic.toString(), position.debt.decimals, position.debt.decimals)} ${position.debt.asset}`,
    assumption: projection.assumption,
  };
}

export function simpleInterestAtomic(amountAtomic: string, annualRateBps: number, days: number): string {
  return (
    (BigInt(amountAtomic) * BigInt(annualRateBps) * BigInt(days)) /
    BigInt(10_000 * DAYS_PER_YEAR)
  ).toString();
}

function simpleInterestUsd(valueUsd: string | null, annualRateBps: number, days: number): string | null {
  if (valueUsd == null) return null;
  return (Number(valueUsd) * (annualRateBps / 10_000) * (days / DAYS_PER_YEAR)).toFixed(2);
}

function apyProjectionUsd(valueUsd: string | null, annualRateBps: number, days: number): string | null {
  if (valueUsd == null) return null;
  const periodReturn = (1 + annualRateBps / 10_000) ** (days / DAYS_PER_YEAR) - 1;
  return (Number(valueUsd) * periodReturn).toFixed(2);
}

function addUsd(a: string | null, b: string | null): string | null {
  return a != null && b != null ? String(Number(a) + Number(b)) : null;
}
