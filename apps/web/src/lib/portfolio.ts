import type { Position, RiskFinding } from "../../../../packages/domain/src/index.js";
import type { StatusTone } from "../components/Ui.js";

export function humanAmount(amountAtomic: string, decimals: number, maximumFractionDigits = 6): string {
  const padded = amountAtomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const rawFraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
  const fraction = rawFraction.slice(0, maximumFractionDigits);
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatUsd(value: string | null | undefined): string {
  if (value == null) return "n/a";
  const number = Number(value);
  if (!Number.isFinite(number)) return `$${value}`;
  const magnitude = Math.abs(number).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return number < 0 ? `−$${magnitude}` : `$${magnitude}`;
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
