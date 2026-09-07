import type { Position, PositionEnvelope, PortfolioSummary, RiskFinding } from "../../domain/src/index.js";
import { decimalToScaled, ratioToDecimal } from "../../domain/src/money.js";

const USD_SCALE = 100_000_000n;

function usd(value: bigint): string {
  return ratioToDecimal(value, USD_SCALE, 2) ?? "0";
}

export interface PortfolioAnalysisOptions {
  /** Live DIA (or other trusted) BTC/USD mark. Null when unavailable — never invent $100k. */
  btcReferencePriceUsd?: string | null;
}

function valueOf(position: Position): bigint | null {
  if (position.type === "wallet" || position.type === "supply") return position.asset.valueUsd === null ? null : decimalToScaled(position.asset.valueUsd);
  if (position.type === "lending") {
    if (position.collateral.valueUsd === null) return null;
    return decimalToScaled(position.collateral.valueUsd);
  }
  if (position.token0.valueUsd === null || position.token1.valueUsd === null) return null;
  return decimalToScaled(position.token0.valueUsd) + decimalToScaled(position.token1.valueUsd);
}

function debtOf(position: Position): bigint {
  return position.type === "lending" && position.debt.valueUsd !== null ? decimalToScaled(position.debt.valueUsd) : 0n;
}

function assetsOf(position: Position): Array<{ asset: string; value: bigint }> {
  if (position.type === "wallet" || position.type === "supply") {
    return position.asset.valueUsd === null ? [] : [{ asset: position.asset.asset, value: decimalToScaled(position.asset.valueUsd) }];
  }
  if (position.type === "lending") {
    return position.collateral.valueUsd === null ? [] : [{ asset: position.collateral.asset, value: decimalToScaled(position.collateral.valueUsd) }];
  }
  return [position.token0, position.token1].flatMap((asset) =>
    asset.valueUsd === null ? [] : [{ asset: asset.asset, value: decimalToScaled(asset.valueUsd) }],
  );
}

function isIdleWallet(position: Position): boolean {
  return position.type === "wallet" && position.spendable;
}

function isLockedWallet(position: Position): boolean {
  return position.type === "wallet" && !position.spendable;
}

function group(items: Array<{ key: string; value: bigint }>, total: bigint) {
  const sums = new Map<string, bigint>();
  for (const item of items) sums.set(item.key, (sums.get(item.key) ?? 0n) + item.value);
  return [...sums]
    .sort((a, b) => (a[1] > b[1] ? -1 : 1))
    .map(([key, value]) => ({
      key,
      valueUsd: usd(value),
      percentageBps: total > 0n ? Number((value * 10_000n) / total) : 0,
      meaning: `${((total > 0n ? Number((value * 10_000n) / total) : 0) / 100).toFixed(1)}% of valued portfolio assets sit in ${key}.`,
    }));
}

function classification(score: number): PortfolioSummary["risk"]["classification"] {
  return score >= 80 ? "critical" : score >= 60 ? "high-risk" : score >= 30 ? "guarded" : "healthy";
}

function classificationMeaning(kind: PortfolioSummary["risk"]["classification"]): string {
  if (kind === "critical") return "Immediate attention — one or more findings imply imminent loss of capital control.";
  if (kind === "high-risk") return "Material danger — a normal Bitcoin move could force liquidation or sticky exits.";
  if (kind === "guarded") return "Watch closely — buffers exist but are thinner than a conservative policy.";
  return "No high-severity findings in the current evidence set.";
}

function scenario(
  envelope: PositionEnvelope,
  totalAssets: bigint,
  totalDebt: bigint,
  percentage: number,
): PortfolioSummary["scenarios"][number] {
  let affected = 0;
  let loss = 0n;
  for (const position of envelope.positions) {
    const bitcoinAssets = assetsOf(position).filter((asset) => /btc/i.test(asset.asset));
    if (bitcoinAssets.length > 0) {
      affected += 1;
      for (const asset of bitcoinAssets) loss += (asset.value * BigInt(percentage)) / 100n;
    }
  }
  return {
    name: `BTC −${percentage}%`,
    shock: `btc:${-percentage}`,
    estimatedNetValueUsd: usd(totalAssets - totalDebt - loss),
    estimatedLossUsd: usd(loss),
    positionsAffected: affected,
    explanation: affected
      ? `${affected} Bitcoin-linked position${affected === 1 ? " is" : "s are"} repriced; debt is held constant so health worsens as collateral falls.`
      : "No valued Bitcoin exposure is available for this scenario.",
  };
}

function btcLinkedAssetValue(known: Array<{ position: Position; value: bigint }>): bigint {
  let total = 0n;
  for (const item of known) {
    for (const asset of assetsOf(item.position)) {
      if (/btc/i.test(asset.asset)) total += asset.value;
    }
  }
  return total;
}

export function analyzePortfolio(
  envelope: PositionEnvelope,
  findings: RiskFinding[],
  options: PortfolioAnalysisOptions = {},
): PortfolioSummary {
  const valued = envelope.positions.map((position) => ({ position, value: valueOf(position) }));
  const known = valued.filter((item): item is { position: Position; value: bigint } => item.value !== null);
  const totalAssets = known.reduce((sum, item) => sum + item.value, 0n);
  const totalDebt = envelope.positions.reduce((sum, position) => sum + debtOf(position), 0n);
  const deployed = known.filter((item) => item.position.type !== "wallet").reduce((sum, item) => sum + item.value, 0n);
  const idle = known.filter((item) => isIdleWallet(item.position)).reduce((sum, item) => sum + item.value, 0n);
  const locked = known.filter((item) => isLockedWallet(item.position)).reduce((sum, item) => sum + item.value, 0n);
  const maxRisk = findings.reduce((score, item) => Math.max(score, item.score), 0);
  const confidenceInputs = findings.length
    ? findings.map((finding) => finding.confidence.score)
    : envelope.positions.map((position) => position.confidence.score);
  const confidence = confidenceInputs.length
    ? confidenceInputs.reduce((sum, score) => sum + score, 0) / confidenceInputs.length
    : 0;
  const severeIds = new Set(
    findings.filter((item) => item.severity === "high" || item.severity === "critical").map((item) => item.positionId),
  );
  const capitalAtRisk = known.filter((item) => severeIds.has(item.position.id)).reduce((sum, item) => sum + item.value, 0n);
  const drivers = [...findings]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => ({
      positionId: item.positionId,
      title: item.title,
      score: item.score,
      severity: item.severity,
      meaning: item.meaning,
      doNothing: item.ifYouDoNothing,
      recommendedAction: item.recommendedActions[0]?.type ?? null,
    }));

  const topAction = drivers.find((item) => item.recommendedAction)?.recommendedAction ?? null;
  // A post-action score is only defensible after simulating the exact intent against a pinned tip.
  const expectedScoreAfterAction = null;
  const protocols = [...new Set(envelope.positions.map((position) => position.protocol.id))];
  const btcAssets = btcLinkedAssetValue(known);
  const holdBtc = btcAssets;
  const net = totalAssets - totalDebt;
  const holdDelta = known.length ? net - holdBtc : 0n;

  const warnings = [...envelope.warnings];
  if (known.length !== envelope.positions.length) {
    warnings.push(
      `${envelope.positions.length - known.length} position(s) are excluded from monetary totals because valuation is unavailable.`,
    );
  }
  const btcReferencePriceUsd = options.btcReferencePriceUsd ?? null;
  if (!btcReferencePriceUsd && known.length > 0) {
    warnings.push("BTC reference price is unavailable from DIA; gross BTC-linked exposure uses currently valued positions only.");
  }

  const deployedBps = totalAssets > 0n ? Number((deployed * 10_000n) / totalAssets) : 0;
  const idleBps = totalAssets > 0n ? Number((idle * 10_000n) / totalAssets) : 0;
  const lockedBps = totalAssets > 0n ? Number((locked * 10_000n) / totalAssets) : 0;
  const kind = classification(maxRisk);

  const safestAction = topAction === "repay"
    ? "Prepare a user-signed debt repayment that lifts health toward 1.35."
    : topAction === "remove-liquidity"
      ? "Review removing or rebalancing the LP position that is idle or expensive to exit."
      : topAction === "add-collateral"
        ? "Add collateral only if repayment is less capital-efficient for your policy."
        : "No urgent protective intent is recommended from current evidence.";

  return {
    address: envelope.address,
    asOf: envelope.asOf,
    displayCurrency: "USD",
    currency: "USD",
    headline: known.length
      ? `Net $${usd(net)} across ${envelope.positions.length} positions — ${kind.replace("-", " ")}`
      : "No valued positions yet — inspect a Stacks address to begin.",
    centralAnswer: {
      where: known.length
        ? `${protocols.join(", ")} hold valued capital; ${usd(deployed)} is deployed and ${usd(idle)} is idle/spendable.`
        : "No valued capital resolved for this address yet.",
      earning: envelope.positions.some((position) => position.type === "liquidity")
        ? "LP positions may earn fees while in range; lending may earn supply yield while debt accrues separately. Net APY is shown only when both legs are evidenced."
        : "Yield components appear once protocol rewards and interest evidence are present.",
      canGoWrong: drivers[0]?.meaning ?? "No material risk finding is currently elevated.",
      safestAction,
    },
    totalAssetsUsd: known.length ? usd(totalAssets) : null,
    totalDebtUsd: totalDebt > 0n ? usd(totalDebt) : null,
    netWorthUsd: known.length ? usd(net) : null,
    deployedUsd: known.length ? usd(deployed) : null,
    idleUsd: known.length ? usd(idle) : null,
    lockedOrPendingUsd: known.length ? usd(locked) : null,
    holdBtcComparisonUsd: known.length ? usd(holdBtc) : null,
    holdBtcDeltaUsd: known.length ? usd(holdDelta) : null,
    btcReferencePriceUsd,
    valuedPositionCount: known.length,
    missingValuationCount: envelope.positions.length - known.length,
    metricMeanings: [
      {
        label: "Net worth",
        value: known.length ? `$${usd(net)}` : "n/a",
        meaning: "Valued assets minus valued debt. Unsupported or unpriced legs are excluded, never invented.",
      },
      {
        label: "Deployed",
        value: known.length ? `$${usd(deployed)}` : "n/a",
        meaning: "Capital inside lending or LP protocols rather than a spendable wallet balance.",
      },
      {
        label: "Idle",
        value: known.length ? `$${usd(idle)}` : "n/a",
        meaning: "Spendable wallet assets that can fund a repay, add-collateral, or swap without unlocking.",
      },
      {
        label: "Gross BTC-linked exposure",
        value: known.length ? `$${usd(holdBtc)} BTC-linked` : "n/a",
        meaning: "Sum of valued BTC-linked exposures. The difference from net worth reflects stable assets and debt; it is not historical performance.",
      },
    ],
    risk: {
      score: maxRisk,
      previousScore: null,
      classification: kind,
      classificationMeaning: classificationMeaning(kind),
      trend: "unknown",
      capitalAtRiskUsd: capitalAtRisk > 0n ? usd(capitalAtRisk) : null,
      confidence,
      expectedScoreAfterAction,
      drivers,
    },
    allocations: group(
      known.flatMap((item) => assetsOf(item.position).map((asset) => ({ key: asset.asset, value: asset.value }))),
      totalAssets,
    ),
    protocols: group(
      known.map((item) => ({ key: item.position.protocol.id, value: item.value })),
      totalAssets,
    ),
    deployment: {
      deployedBps,
      idleBps,
      lockedBps,
      meaning: `${(deployedBps / 100).toFixed(1)}% deployed, ${(idleBps / 100).toFixed(1)}% idle, ${(lockedBps / 100).toFixed(1)}% locked/pending among valued assets.`,
    },
    scenarios: [10, 20, 30, 50].map((percentage) => scenario(envelope, totalAssets, totalDebt, percentage)),
    data: {
      state: warnings.length ? "partial" : "complete",
      lastUpdatedAt: envelope.asOf.observedAt,
      stacksBlockHeight: envelope.asOf.stacksBlockHeight,
      bitcoinBlockHeight: envelope.asOf.bitcoinBlockHeight,
      sources: [...new Set(envelope.positions.flatMap((position) => position.provenance.map((item) => item.source)))],
      warnings,
    },
  };
}
