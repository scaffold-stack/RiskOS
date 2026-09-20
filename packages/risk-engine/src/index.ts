import { createHash } from "node:crypto";
import type { LendingPosition, LiquidityPosition, MetricMeaning, Position, RiskFinding } from "../../domain/src/index.js";
import { decimalToScaled, ratioToDecimal } from "../../domain/src/money.js";

const MODEL_VERSION = "1.1.0";

function id(positionId: string, category: string): string {
  return `rk_${createHash("sha256").update(`${positionId}:${category}:${MODEL_VERSION}`).digest("hex").slice(0, 16)}`;
}

function expiresAt(now: Date): string {
  return new Date(now.getTime() + 60_000).toISOString();
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

function lendingLegValue(
  position: LendingPosition,
  kind: "collateral" | "debt",
): bigint | null {
  const legs = position.legs?.[kind] ?? [position[kind]];
  if (legs.some((leg) => leg.valueUsd === null)) return null;
  return legs.reduce((sum, leg) => sum + decimalToScaled(leg.valueUsd!), 0n);
}

function isSingleAssetLendingPosition(position: LendingPosition): boolean {
  return (position.legs?.collateral.length ?? 1) === 1 && (position.legs?.debt.length ?? 1) === 1;
}

export function lendingHealthFactor(position: LendingPosition): string | null {
  const collateral = lendingLegValue(position, "collateral");
  const debt = lendingLegValue(position, "debt");
  if (collateral === null || debt === null || debt === 0n) return null;
  return ratioToDecimal(collateral * BigInt(position.parameters.liquidationThresholdBps), debt * 10_000n, 4);
}

export function lendingLtv(position: LendingPosition): string | null {
  const collateral = lendingLegValue(position, "collateral");
  const debt = lendingLegValue(position, "debt");
  if (collateral === null || debt === null || collateral === 0n) return null;
  return ratioToDecimal(debt, collateral, 4);
}

export function lendingLiquidationPriceUsd(position: LendingPosition): string | null {
  // One liquidation price is not meaningful for a basket with multiple
  // collateral or debt assets; health/LTV remain valid at aggregate USD value.
  if (!isSingleAssetLendingPosition(position)) return null;
  if (position.collateral.valueUsd === null || position.debt.valueUsd === null) return null;
  const amount = BigInt(position.collateral.amountAtomic);
  if (amount === 0n) return null;
  const debt = decimalToScaled(position.debt.valueUsd);
  const threshold = BigInt(position.parameters.liquidationThresholdBps);
  // price = debt / (quantity * threshold), quantity in whole units via decimals
  const quantityScaled = amount * 10n ** 8n / 10n ** BigInt(position.collateral.decimals);
  if (quantityScaled === 0n) return null;
  return ratioToDecimal(debt * 10_000n, quantityScaled * threshold, 2);
}

export function currentCollateralPriceUsd(position: LendingPosition): string | null {
  if (!isSingleAssetLendingPosition(position)) return null;
  if (position.collateral.valueUsd === null) return null;
  const amount = BigInt(position.collateral.amountAtomic);
  if (amount === 0n) return null;
  const quantityScaled = amount * 10n ** 8n / 10n ** BigInt(position.collateral.decimals);
  if (quantityScaled === 0n) return null;
  return ratioToDecimal(decimalToScaled(position.collateral.valueUsd), quantityScaled, 2);
}

function lendingScore(scaledHealth: bigint | null): number {
  if (scaledHealth === null) return 75;
  if (scaledHealth <= 10_000n) return 100;
  if (scaledHealth <= 10_300n) return 90 + Number(((10_300n - scaledHealth) * 10n) / 300n);
  if (scaledHealth <= 11_000n) return 60 + Number(((11_000n - scaledHealth) * 29n) / 700n);
  if (scaledHealth <= 12_000n) return 30 + Number(((12_000n - scaledHealth) * 29n) / 1_000n);
  if (scaledHealth >= 20_000n) return 0;
  return Number(((20_000n - scaledHealth) * 29n) / 8_000n);
}

function bufferFromLiquidation(health: string | null): string | null {
  if (health === null) return null;
  const scaled = decimalToScaled(health, 4);
  if (scaled <= 10_000n) return "0%";
  return ratioToDecimal((scaled - 10_000n) * 100n, 10_000n, 1)! + "%";
}

function lendingRisk(position: LendingPosition, now: Date): RiskFinding {
  const health = lendingHealthFactor(position);
  const ltv = lendingLtv(position);
  const liquidationPrice = lendingLiquidationPriceUsd(position);
  const currentPrice = currentCollateralPriceUsd(position);
  const scaledHealth = health === null ? null : decimalToScaled(health, 4);
  const severity = scaledHealth === null ? "high"
    : scaledHealth <= 10_300n ? "critical"
    : scaledHealth <= 11_000n ? "high"
    : scaledHealth <= 12_000n ? "medium"
    : "low";
  const score = lendingScore(scaledHealth);
  const debt = lendingLegValue(position, "debt") ?? 0n;
  const collateral = lendingLegValue(position, "collateral") ?? 0n;
  const adjusted = collateral * BigInt(position.parameters.liquidationThresholdBps) / 10_000n;
  const targetDebt = adjusted * 10_000n / 13_500n;
  const repayAtomicUsd = debt > targetDebt ? debt - targetDebt : 0n;
  const repay = ratioToDecimal(repayAtomicUsd, 100_000_000n, 2) ?? "0";
  const buffer = bufferFromLiquidation(health);
  const distance = currentPrice && liquidationPrice
    ? ratioToDecimal((decimalToScaled(currentPrice) - decimalToScaled(liquidationPrice)) * 100n, decimalToScaled(currentPrice), 1)
    : null;

  const plainMetrics: MetricMeaning[] = [
    {
      label: "Health factor",
      value: health ?? "unknown",
      meaning: health === null
        ? "RiskOS cannot prove safety until collateral and debt have trusted USD values."
        : Number(health) >= 1.2
          ? `Above 1.0 means the protocol still sees a buffer. ${buffer} room remains before liquidation threshold.`
          : "Below 1.2 is guarded territory — small BTC moves can force collateral sales.",
    },
    {
      label: "LTV",
      value: ltv ? `${(Number(ltv) * 100).toFixed(1)}%` : "unknown",
      meaning: `Debt divided by collateral value. Protocol max LTV is ${pct(position.parameters.maximumLtvBps)}.`,
    },
    {
      label: "Liquidation threshold",
      value: pct(position.parameters.liquidationThresholdBps),
      meaning: "When risk-adjusted collateral falls to this share of debt, liquidation can begin.",
    },
    {
      label: "Est. liquidation price",
      value: liquidationPrice ? `$${Number(liquidationPrice).toLocaleString()}` : "unknown",
      meaning: !isSingleAssetLendingPosition(position)
        ? "A single liquidation price would be misleading for this multi-asset collateral/debt basket; use aggregate health and LTV."
        : distance === null
        ? "Needs a trusted collateral price."
        : `About ${distance}% below the current ${position.collateral.asset} mark if other prices hold.`,
    },
    ...(position.rates ? [
      {
        label: "Borrow APR",
        value: pct(position.rates.borrowAprBps),
        meaning: `Variable annual rate read from the deployed debt vault at Stacks block ${position.rates.observedAtBlock}; it can change with utilization.`,
      },
      {
        label: "Supply APR",
        value: pct(position.rates.supplyAprBps),
        meaning: `Current collateral-vault rate after utilization and reserve factor, not a guaranteed future yield.`,
      },
      {
        label: "Debt after 30 days",
        value: `${ratioToDecimal(BigInt(position.rates.debtProjections.find((item) => item.days === 30)!.amountAtomic), 10n ** BigInt(position.debt.decimals), position.debt.decimals)} ${position.debt.asset}`,
        meaning: position.rates.debtProjections.find((item) => item.days === 30)!.assumption,
      },
    ] satisfies MetricMeaning[] : []),
  ];

  const meaning = health === null
    ? "This lending position cannot be scored safely because valuation evidence is incomplete."
    : `Your ${position.collateral.asset} collateral is securing ${position.debt.asset} debt with health factor ${health}.`;

  return {
    riskId: id(position.id, "liquidation"),
    positionId: position.id,
    severity,
    category: "liquidation",
    score: Math.max(0, Math.min(100, score)),
    title: health === null ? "Liquidation health cannot be calculated" : `Lending health factor is ${health}`,
    meaning,
    whyItMatters: "If health reaches 1.0 under protocol rules, the market can sell your collateral and charge a penalty — often before you can manually unwind.",
    ifYouDoNothing: severity === "low"
      ? "The buffer can still shrink as interest accrues or Bitcoin price falls. Recheck after material moves."
      : "Debt can keep accruing and a Bitcoin drawdown can liquidate collateral without another warning.",
    plainMetrics,
    evidence: [
      {
        metric: "healthFactor",
        value: health ?? "unknown",
        ...(position.provenance[0]?.blockHeight !== undefined ? { sourceBlock: position.provenance[0].blockHeight } : {}),
      },
      { metric: "ltv", value: ltv ?? "unknown" },
      { metric: "liquidationThresholdBps", value: String(position.parameters.liquidationThresholdBps) },
      { metric: "maximumLtvBps", value: String(position.parameters.maximumLtvBps) },
      { metric: "collateralValueUsd", value: collateral > 0n ? ratioToDecimal(collateral, 100_000_000n, 2)! : "unknown" },
      { metric: "debtValueUsd", value: debt > 0n ? ratioToDecimal(debt, 100_000_000n, 2)! : "unknown" },
      { metric: "estimatedLiquidationPriceUsd", value: liquidationPrice ?? "unknown" },
      { metric: "currentCollateralPriceUsd", value: currentPrice ?? "unknown" },
      ...(position.rates ? [
        { metric: "borrowAprBps", value: String(position.rates.borrowAprBps), sourceBlock: position.rates.observedAtBlock },
        { metric: "supplyAprBps", value: String(position.rates.supplyAprBps), sourceBlock: position.rates.observedAtBlock },
        { metric: "debtAfter30DaysAtomic", value: position.rates.debtProjections.find((item) => item.days === 30)!.amountAtomic, sourceBlock: position.rates.observedAtBlock },
      ] : []),
    ],
    scenarios: [
      {
        name: "Collateral -10%",
        result: health === null ? "unknown" : ratioToDecimal(scaledHealth! * 90n, 1_000_000n, 4)!,
        meaning: "If Bitcoin-linked collateral falls 10% and debt stays flat, health becomes this value.",
      },
      {
        name: "Collateral -20%",
        result: health === null ? "unknown" : ratioToDecimal(scaledHealth! * 80n, 1_000_000n, 4)!,
        meaning: "A sharper drawdown. Values at or below 1.0 imply liquidation risk under current parameters.",
      },
      {
        name: "Collateral -30%",
        result: health === null ? "unknown" : ratioToDecimal(scaledHealth! * 70n, 1_000_000n, 4)!,
        meaning: "A severe drawdown. Values at or below 1.0 are liquidation territory in this model.",
      },
    ],
    recommendedActions: repayAtomicUsd > 0n ? [{
      type: "repay",
      amount: `${repay} ${position.debt.asset}`,
      meaning: `Repaying about $${repay} of ${position.debt.asset} is the capital path RiskOS models to reach health 1.35.`,
    }] : [],
    model: { id: "protocol-lending-liquidation", version: MODEL_VERSION },
    confidence: position.confidence,
    expiresAt: expiresAt(now),
  };
}

function evidenceFreshnessRisk(position: Position, now: Date, maximumAgeSeconds: number): RiskFinding | null {
  if (position.provenance.every((item) => item.source === "fixture")) return null;
  const newest = Math.max(...position.provenance.map((item) => Date.parse(item.observedAt)).filter(Number.isFinite));
  const ageSeconds = Number.isFinite(newest) ? Math.max(0, Math.floor((now.getTime() - newest) / 1000)) : Number.MAX_SAFE_INTEGER;
  const missingPrice = position.type === "wallet" || position.type === "supply" ? position.asset.valueUsd === null
    : position.type === "lending" ? lendingLegValue(position, "collateral") === null || lendingLegValue(position, "debt") === null
    : position.token0.valueUsd === null || position.token1.valueUsd === null;
  if (!missingPrice && ageSeconds <= maximumAgeSeconds && position.confidence.state !== "degraded") return null;
  const severity = missingPrice || ageSeconds > maximumAgeSeconds * 3 ? "high" : "medium";
  return {
    riskId: id(position.id, "oracle"),
    positionId: position.id,
    severity,
    category: "oracle",
    score: severity === "high" ? 75 : 50,
    title: missingPrice ? "Required valuation evidence is unavailable" : "Position evidence is stale or degraded",
    meaning: missingPrice
      ? "RiskOS will not invent a price. Without a trusted valuation, protective actions stay blocked."
      : `Evidence is ${ageSeconds}s old versus a ${maximumAgeSeconds}s freshness budget.`,
    whyItMatters: "Stale or missing prices can produce false comfort — or worse, a transaction that is no longer safe at signing time.",
    ifYouDoNothing: "Portfolio totals and liquidation math remain incomplete; RiskOS fails closed rather than guessing.",
    plainMetrics: [
      { label: "Evidence age", value: `${ageSeconds}s`, meaning: "Time since the newest provenance observation on this position." },
      { label: "Freshness budget", value: `${maximumAgeSeconds}s`, meaning: "RiskOS safety window for acting on this reading." },
      { label: "Price available", value: String(!missingPrice), meaning: "Whether USD valuation inputs are present for every required leg." },
    ],
    evidence: [
      { metric: "evidenceAgeSeconds", value: String(ageSeconds) },
      { metric: "maximumAgeSeconds", value: String(maximumAgeSeconds) },
      { metric: "priceAvailable", value: String(!missingPrice) },
    ],
    scenarios: [{
      name: "Fail-closed valuation",
      result: "Risk-dependent actions remain blocked until fresh evidence is reconciled",
      meaning: "Safer than signing against disputed market data.",
    }],
    recommendedActions: [],
    model: { id: "evidence-freshness", version: MODEL_VERSION },
    confidence: {
      state: "degraded",
      score: Math.min(position.confidence.score, 0.4),
      reasons: [...position.confidence.reasons, "Fresh reconciled pricing is required"],
    },
    expiresAt: expiresAt(now),
  };
}

function liquidityRisk(position: LiquidityPosition, now: Date): RiskFinding {
  const lower = decimalToScaled(position.lowerPrice);
  const upper = decimalToScaled(position.upperPrice);
  const current = decimalToScaled(position.currentPrice);
  const inRange = current >= lower && current <= upper;
  const highSlippage = position.exitSlippageBps !== null && position.exitSlippageBps > 100;
  const quoteUnavailable = position.exitSlippageBps === null;
  const toLower = inRange && current > 0n ? ratioToDecimal((current - lower) * 100n, current, 1) : null;
  const toUpper = inRange && current > 0n ? ratioToDecimal((upper - current) * 100n, current, 1) : null;
  const severity = !inRange || highSlippage || quoteUnavailable ? "medium" : "low";
  const score = !inRange ? 55 : highSlippage ? 45 : quoteUnavailable ? 35 : 15;
  return {
    riskId: id(position.id, "liquidity"),
    positionId: position.id,
    severity,
    category: "liquidity",
    score,
    title: !inRange ? "Liquidity position is out of range" : highSlippage ? "Estimated exit slippage exceeds 1%" : quoteUnavailable ? "Exit liquidity quote is unavailable" : "Liquidity position is active",
    meaning: !inRange
      ? "Your concentrated range no longer covers the market price, so fee earnings pause until price returns or you rebalance."
      : highSlippage
        ? "You can still exit, but the modeled route costs more than 1% versus mid — capital is sticky."
        : quoteUnavailable
          ? "The position is in range, but exit cost cannot be scored until a size-specific quote is available."
          : "The position is in range and currently eligible to earn trading fees.",
    whyItMatters: quoteUnavailable
      ? "Without an executable quote, RiskOS cannot quantify whether this capital can be exited within your slippage policy."
      : "Out-of-range or expensive-to-exit LP capital can lose fee income while still carrying impermanent-loss risk.",
    ifYouDoNothing: !inRange
      ? "Fees stop accruing until price re-enters your range; IL versus simply holding both assets can widen."
      : quoteUnavailable
        ? "Fee eligibility may continue, but executable liquidity remains unknown until a fresh quote succeeds."
        : "Monitor exit slippage and incentive expiry; temporary incentives can mask thin liquidity.",
    plainMetrics: [
      {
        label: "Range status",
        value: inRange ? "In range" : "Out of range",
        meaning: `Bounds ${position.lowerPrice} – ${position.upperPrice}; market ${position.currentPrice}.`,
      },
      {
        label: "Distance in range",
        value: inRange && toLower && toUpper ? `${toLower}% from low / ${toUpper}% from high` : "Not modeled",
        meaning: "Price distance from the current market mark to each range bound.",
      },
      {
        label: "Exit slippage",
        value: position.exitSlippageBps === null ? "unknown" : `${(position.exitSlippageBps / 100).toFixed(2)}%`,
        meaning: "Estimated cost to remove liquidity and realize tokens at the current quote size.",
      },
    ],
    evidence: [
      {
        metric: "inRange",
        value: String(inRange),
        ...(position.provenance[0]?.blockHeight !== undefined ? { sourceBlock: position.provenance[0].blockHeight } : {}),
      },
      { metric: "exitSlippageBps", value: position.exitSlippageBps?.toString() ?? "unknown" },
      { metric: "lowerPrice", value: position.lowerPrice },
      { metric: "upperPrice", value: position.upperPrice },
      { metric: "currentPrice", value: position.currentPrice },
    ],
    scenarios: [{
      name: "Exit now",
      result: position.exitSlippageBps === null ? "quote unavailable" : `${position.exitSlippageBps} bps slippage`,
      meaning: "Modeled impact for removing the full position at the last observed quote.",
    }],
    recommendedActions: highSlippage || !inRange
      ? [{ type: "remove-liquidity", meaning: "Exit or rebalance if idle capital or exit cost exceeds your policy." }]
      : [],
    model: { id: "concentrated-liquidity", version: MODEL_VERSION },
    confidence: quoteUnavailable ? {
      state: "degraded",
      score: Math.min(position.confidence.score, 0.65),
      reasons: [...position.confidence.reasons, "Live size-specific exit quote unavailable"],
    } : position.confidence,
    expiresAt: expiresAt(now),
  };
}

export function evaluateRisks(positions: Position[], now = new Date(), maximumEvidenceAgeSeconds = 300): RiskFinding[] {
  return positions.flatMap((position) => {
    const findings: RiskFinding[] = [];
    if (position.type === "lending") findings.push(lendingRisk(position, now));
    else if (position.type === "liquidity") findings.push(liquidityRisk(position, now));
    if (position.confidence.state === "unsupported") {
      findings.push({
        riskId: id(position.id, "unsupported"),
        positionId: position.id,
        severity: "info",
        category: "unsupported",
        score: 0,
        title: "Asset exposure is not yet supported",
        meaning: "RiskOS detected capital it cannot safely model yet. The raw balance remains visible as unsupported exposure.",
        whyItMatters: "Ignoring unknown contracts would hide real Bitcoin risk. Showing them prevents silent blind spots.",
        ifYouDoNothing: "Totals may understate portfolio risk until an approved adapter covers this contract.",
        plainMetrics: [],
        evidence: [],
        scenarios: [],
        recommendedActions: [],
        model: { id: "unsupported-exposure", version: MODEL_VERSION },
        confidence: position.confidence,
        expiresAt: expiresAt(now),
      });
    }
    const freshness = evidenceFreshnessRisk(position, now, maximumEvidenceAgeSeconds);
    if (freshness) findings.push(freshness);
    return findings;
  });
}
