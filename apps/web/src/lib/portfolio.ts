import type { Position, RiskFinding } from "../../../../packages/domain/src/index.js";
import type { StatusTone } from "../components/Ui.js";

/**
 * Format an on-chain atomic amount for display. Defaults to magnitude-aware
 * precision and strips trailing zeros so balances stay readable in tables.
 */
export function humanAmount(amountAtomic: string, decimals: number, maximumFractionDigits?: number): string {
  const normalized = amountAtomic.replace(/^0+(?=\d)/, "") || "0";
  if (!/^\d+$/.test(normalized)) return amountAtomic;
  const padded = normalized.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const rawFraction = decimals === 0 ? "" : padded.slice(-decimals);
  const wholeValue = Number(whole);
  const digits =
    maximumFractionDigits ??
    (wholeValue >= 1_000 ? 2 : wholeValue >= 1 ? 4 : 6);
  const fraction = rawFraction.slice(0, Math.max(0, digits)).replace(/0+$/, "");
  const wholeFormatted = wholeValue.toLocaleString("en-US");
  return fraction ? `${wholeFormatted}.${fraction}` : wholeFormatted;
}

export function formatUsd(value: string | null | undefined): string {
  if (value == null) return "Unavailable";
  const number = Number(value);
  if (!Number.isFinite(number)) return `$${value}`;
  const magnitude = Math.abs(number).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return number < 0 ? `−$${magnitude}` : `$${magnitude}`;
}

export function formatPct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function primaryAsset(position: Position) {
  if (position.type === "lending") return position.collateral;
  if (position.type === "liquidity") return position.token0;
  return position.asset;
}

export function positionValue(position: Position): string {
  const asset = primaryAsset(position);
  return asset.valueUsd
    ? formatUsd(asset.valueUsd)
    : `${humanAmount(asset.amountAtomic, asset.decimals)} ${asset.asset}`;
}

export function severityTone(severity: RiskFinding["severity"] | undefined): StatusTone {
  if (severity === "critical" || severity === "high") return "critical";
  if (severity === "medium") return "caution";
  if (severity === "low" || severity === "info") return "healthy";
  return "uncertain";
}

export function shortAddress(address: string): string {
  return address.length > 18 ? `${address.slice(0, 9)}…${address.slice(-7)}` : address;
}

export function riskLabel(risks: RiskFinding[]): string {
  const highest = risks.reduce((score, risk) => Math.max(score, risk.score), 0);
  if (highest >= 80) return "Critical";
  if (highest >= 60) return "High risk";
  if (highest >= 30) return "Guarded";
  if (highest > 0) return "Healthy";
  return "Not scored";
}
