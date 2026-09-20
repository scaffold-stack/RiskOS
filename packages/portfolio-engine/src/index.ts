import type { Position, PositionEnvelope, PortfolioSummary, RiskFinding } from "../../domain/src/index.js";
import { decimalToScaled, ratioToDecimal } from "../../domain/src/money.js";

const USD_SCALE = 100_000_000n;

function usd(value: bigint): string {
  return ratioToDecimal(value, USD_SCALE, 2) ?? "0";
}

export interface PortfolioAnalysisOptions {
  /** Live DIA (or other trusted) BTC/USD mark. Null when unavailable — never invent $100k. */
  btcReferencePriceUsd?: string | null;
  /** Explicitly limited to deterministic fixture/demo flows; production callers must leave this false. */
  allowFixtureEvidence?: boolean;
}

function monetaryLegs(position: Position) {
  if (position.type === "wallet" || position.type === "supply") return [position.asset];
  if (position.type === "lending") {
    const legs = position.legs ?? { collateral: [position.collateral], debt: [position.debt] };
    return [...legs.collateral, ...legs.debt];
  }
  return [position.token0, position.token1];
}

function hasVerifiedMonetaryEvidence(position: Position): boolean {
  if (position.confidence.state !== "verified") return false;
  return monetaryLegs(position).every(
    (leg) =>
      leg.valueUsd !== null &&
      leg.valuation !== undefined &&
      leg.valuation.source !== "fixture" &&
      leg.valuation.confidence >= 0.8,
  );
}

function hasAcceptedMonetaryValue(position: Position, allowFixtureEvidence: boolean): boolean {
  if (position.confidence.state === "unsupported") return false;
  return monetaryLegs(position).every((leg) =>
    leg.valueUsd !== null && (
      allowFixtureEvidence || (
        leg.valuation !== undefined &&
        leg.valuation.source !== "fixture" &&
        leg.valuation.confidence >= 0.7
      )
    ),
  );
}

function valueOf(position: Position): bigint | null {
  if (position.type === "wallet" || position.type === "supply")
    return position.asset.valueUsd === null ? null : decimalToScaled(position.asset.valueUsd);
  if (position.type === "lending") {
    const collateral = position.legs?.collateral ?? [position.collateral];
    if (collateral.some((leg) => leg.valueUsd === null)) return null;
    return collateral.reduce((sum, leg) => sum + decimalToScaled(leg.valueUsd!), 0n);
  }
  if (position.token0.valueUsd === null || position.token1.valueUsd === null) return null;
  return decimalToScaled(position.token0.valueUsd) + decimalToScaled(position.token1.valueUsd);
}

function debtOf(position: Position): bigint | null {
  if (position.type !== "lending") return 0n;
  const debt = position.legs?.debt ?? [position.debt];
  if (debt.some((leg) => leg.valueUsd === null)) return null;
  return debt.reduce((sum, leg) => sum + decimalToScaled(leg.valueUsd!), 0n);
}

function assetsOf(position: Position): Array<{ asset: string; value: bigint }> {
  if (position.type === "wallet" || position.type === "supply") {
    return position.asset.valueUsd === null
      ? []
      : [{ asset: position.asset.asset, value: decimalToScaled(position.asset.valueUsd) }];
  }
  if (position.type === "lending") {
    const collateral = position.legs?.collateral ?? [position.collateral];
    return collateral.flatMap((asset) =>
      asset.valueUsd === null ? [] : [{ asset: asset.asset, value: decimalToScaled(asset.valueUsd) }],
    );
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
  if (kind === "critical")
    return "Immediate attention — one or more findings imply imminent loss of capital control.";
  if (kind === "high-risk")
    return "Material danger — a normal Bitcoin move could force liquidation or sticky exits.";
  if (kind === "guarded") return "Watch closely — buffers exist but are thinner than a conservative policy.";
  return "No high-severity findings in the current evidence set.";
}

function scenario(
  envelope: PositionEnvelope,
  totalAssets: bigint,
  totalDebt: bigint,
  percentage: number,
  calculable: boolean,
  scope: "complete-portfolio" | "valued-subset",
  excludedPositionCount: number,
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
    estimatedNetValueUsd: calculable ? usd(totalAssets - totalDebt - loss) : null,
    estimatedLossUsd: calculable ? usd(loss) : null,
    positionsAffected: affected,
    scope,
    excludedPositionCount,
    explanation: affected
      ? `${affected} Bitcoin-linked position${affected === 1 ? " is" : "s are"} repriced; debt is held constant so health worsens as collateral falls.${scope === "valued-subset" ? ` ${excludedPositionCount} unsupported or insufficiently evidenced position${excludedPositionCount === 1 ? " is" : "s are"} excluded.` : ""}`
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
  const debts = envelope.positions.map((position) => ({ position, value: debtOf(position) }));
  const knownDebts = debts.filter(
    (item): item is { position: Position; value: bigint } => item.value !== null,
  );
  const incompletePositionIds = new Set([
    ...valued
      .filter((item) => item.value === null && item.position.confidence.state !== "unsupported")
      .map((item) => item.position.id),
    ...debts
      .filter((item) => item.value === null && item.position.confidence.state !== "unsupported")
      .map((item) => item.position.id),
    ...(!options.allowFixtureEvidence
      ? envelope.positions
          .filter((position) => position.confidence.state !== "unsupported")
          .filter((position) => !hasVerifiedMonetaryEvidence(position))
          .map((position) => position.id)
      : []),
  ]);
  const monetaryComplete =
    envelope.positions.some((position) => position.confidence.state !== "unsupported") &&
    incompletePositionIds.size === 0;
  const verifiedPositions = envelope.positions.filter(hasVerifiedMonetaryEvidence);
  const verifiedSubtotal = verifiedPositions.reduce((sum, position) => {
    const value = valueOf(position);
    const debt = debtOf(position);
    return value === null || debt === null ? sum : sum + value - debt;
  }, 0n);
  const valuedPositions = envelope.positions.filter((position) =>
    hasAcceptedMonetaryValue(position, options.allowFixtureEvidence === true),
  );
  const valuedSubtotal = valuedPositions.reduce((sum, position) => {
    const value = valueOf(position);
    const debt = debtOf(position);
    return value === null || debt === null ? sum : sum + value - debt;
  }, 0n);
  const valuedItems = valuedPositions.flatMap((position) => {
    const value = valueOf(position);
    return value === null ? [] : [{ position, value }];
  });
  const valuedAssetsSubtotal = valuedItems.reduce((sum, item) => sum + item.value, 0n);
  const valuedDebtSubtotal = valuedPositions.reduce((sum, position) => {
    const debt = debtOf(position);
    return debt === null ? sum : sum + debt;
  }, 0n);
  const valuedDeployedSubtotal = valuedItems
    .filter((item) => item.position.type !== "wallet")
    .reduce((sum, item) => sum + item.value, 0n);
  const valuedIdleSubtotal = valuedItems
    .filter((item) => isIdleWallet(item.position))
    .reduce((sum, item) => sum + item.value, 0n);
  const valuedLockedSubtotal = valuedItems
    .filter((item) => isLockedWallet(item.position))
    .reduce((sum, item) => sum + item.value, 0n);
  const valuedBtcExposureSubtotal = btcLinkedAssetValue(valuedItems);
  const valuedNetVsBtcExposure = valuedSubtotal - valuedBtcExposureSubtotal;
  const totalAssets = known.reduce((sum, item) => sum + item.value, 0n);
  const totalDebt = knownDebts.reduce((sum, item) => sum + item.value, 0n);
  const deployed = known
    .filter((item) => item.position.type !== "wallet")
    .reduce((sum, item) => sum + item.value, 0n);
  const idle = known
    .filter((item) => isIdleWallet(item.position))
    .reduce((sum, item) => sum + item.value, 0n);
  const locked = known
    .filter((item) => isLockedWallet(item.position))
    .reduce((sum, item) => sum + item.value, 0n);
  const maxRisk = findings.reduce((score, item) => Math.max(score, item.score), 0);
  const confidenceInputs = findings.length
    ? findings.map((finding) => finding.confidence.score)
    : envelope.positions.map((position) => position.confidence.score);
  const confidence = confidenceInputs.length
    ? confidenceInputs.reduce((sum, score) => sum + score, 0) / confidenceInputs.length
    : 0;
  const severeIds = new Set(
    findings
      .filter((item) => item.severity === "high" || item.severity === "critical")
      .map((item) => item.positionId),
  );
  const capitalAtRisk = known
    .filter((item) => severeIds.has(item.position.id))
    .reduce((sum, item) => sum + item.value, 0n);
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
  const holdDelta = monetaryComplete ? net - holdBtc : 0n;

  // Integrity notices stay in headline / valued-subtotal fields — do not push them
  // into warnings (those surface as alarming UI banners for expected incomplete books).
  const warnings = [...envelope.warnings];
  const btcReferencePriceUsd = options.btcReferencePriceUsd ?? null;

  const allocationAssets = monetaryComplete ? totalAssets : valuedAssetsSubtotal;
  const allocationDeployed = monetaryComplete ? deployed : valuedDeployedSubtotal;
  const allocationIdle = monetaryComplete ? idle : valuedIdleSubtotal;
  const allocationLocked = monetaryComplete ? locked : valuedLockedSubtotal;
  const deployedBps = allocationAssets > 0n ? Number((allocationDeployed * 10_000n) / allocationAssets) : 0;
  const idleBps = allocationAssets > 0n ? Number((allocationIdle * 10_000n) / allocationAssets) : 0;
  const lockedBps = allocationAssets > 0n ? Number((allocationLocked * 10_000n) / allocationAssets) : 0;
  const kind = classification(maxRisk);

  const safestAction =
    topAction === "repay"
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
    headline: monetaryComplete
      ? `Net $${usd(net)} across ${envelope.positions.length} positions — ${kind.replace("-", " ")}`
      : valuedPositions.length > 0
        ? `Valued net subtotal $${usd(valuedSubtotal)} across ${valuedPositions.length} position(s); exact portfolio total remains unavailable.`
        : envelope.positions.length
          ? "Exact portfolio total unavailable — no position currently has complete accepted monetary evidence."
        : "No valued positions yet — inspect a Stacks address to begin.",
    centralAnswer: {
      where: monetaryComplete
        ? `${protocols.join(", ")} hold valued capital; ${usd(deployed)} is deployed and ${usd(idle)} is idle/spendable.`
        : valuedPositions.length > 0
          ? `${protocols.join(", ")} contain $${usd(valuedAssetsSubtotal)} of valued assets across ${valuedPositions.length} position(s); unsupported or insufficiently evidenced positions are excluded.`
          : envelope.positions.length
            ? "Positions were found, but none currently has complete accepted monetary evidence."
          : "No valued capital resolved for this address yet.",
      earning: envelope.positions.some((position) => position.type === "liquidity")
        ? "LP positions may earn fees while in range; lending may earn supply yield while debt accrues separately. Net APY is shown only when both legs are evidenced."
        : "Yield components appear once protocol rewards and interest evidence are present.",
      canGoWrong: drivers[0]?.meaning ?? "No material risk finding is currently elevated.",
      safestAction,
    },
    totalAssetsUsd: monetaryComplete ? usd(totalAssets) : null,
    totalDebtUsd: monetaryComplete ? usd(totalDebt) : null,
    netWorthUsd: monetaryComplete ? usd(net) : null,
    deployedUsd: monetaryComplete ? usd(deployed) : null,
    idleUsd: monetaryComplete ? usd(idle) : null,
    lockedOrPendingUsd: monetaryComplete ? usd(locked) : null,
    holdBtcComparisonUsd: monetaryComplete ? usd(holdBtc) : null,
    holdBtcDeltaUsd: monetaryComplete ? usd(holdDelta) : null,
    btcReferencePriceUsd,
    verifiedSubtotalUsd: verifiedPositions.length > 0 ? usd(verifiedSubtotal) : null,
    verifiedSubtotalPositionCount: verifiedPositions.length,
    valuedSubtotalUsd: valuedPositions.length > 0 ? usd(valuedSubtotal) : null,
    valuedSubtotalPositionCount: valuedPositions.length,
    valuedAssetsSubtotalUsd: valuedPositions.length > 0 ? usd(valuedAssetsSubtotal) : null,
    valuedDebtSubtotalUsd: valuedPositions.length > 0 ? usd(valuedDebtSubtotal) : null,
    valuedDeployedSubtotalUsd: valuedPositions.length > 0 ? usd(valuedDeployedSubtotal) : null,
    valuedIdleSubtotalUsd: valuedPositions.length > 0 ? usd(valuedIdleSubtotal) : null,
    valuedLockedSubtotalUsd: valuedPositions.length > 0 ? usd(valuedLockedSubtotal) : null,
    valuedBtcExposureSubtotalUsd: valuedPositions.length > 0 ? usd(valuedBtcExposureSubtotal) : null,
    valuedNetVsBtcExposureUsd: valuedPositions.length > 0 ? usd(valuedNetVsBtcExposure) : null,
    valuedPositionCount: valuedPositions.length,
    missingValuationCount: incompletePositionIds.size,
    metricMeanings: [
      {
        label: "Net worth",
        value: monetaryComplete
          ? `$${usd(net)}`
          : valuedPositions.length > 0
            ? `$${usd(valuedSubtotal)} valued subtotal`
            : "unavailable",
        meaning:
          "Every asset value minus every debt value. The total is withheld if any leg is unpriced; missing debt is never treated as zero.",
      },
      {
        label: "Deployed",
        value: monetaryComplete || valuedPositions.length > 0
          ? `$${usd(monetaryComplete ? deployed : valuedDeployedSubtotal)}${monetaryComplete ? "" : " valued subset"}`
          : "unavailable",
        meaning: "Capital inside lending or LP protocols rather than a spendable wallet balance.",
      },
      {
        label: "Idle",
        value: monetaryComplete || valuedPositions.length > 0
          ? `$${usd(monetaryComplete ? idle : valuedIdleSubtotal)}${monetaryComplete ? "" : " valued subset"}`
          : "unavailable",
        meaning: "Spendable wallet assets that can fund a repay, add-collateral, or swap without unlocking.",
      },
      {
        label: "Gross BTC-linked exposure",
        value: monetaryComplete || valuedPositions.length > 0
          ? `$${usd(monetaryComplete ? holdBtc : valuedBtcExposureSubtotal)} BTC-linked${monetaryComplete ? "" : " valued subset"}`
          : "unavailable",
        meaning:
          "Sum of valued BTC-linked exposures. The difference from net worth reflects stable assets and debt; it is not historical performance.",
      },
    ],
    risk: {
      score: maxRisk,
      previousScore: null,
      classification: kind,
      classificationMeaning: classificationMeaning(kind),
      trend: "unknown",
      capitalAtRiskUsd: monetaryComplete && capitalAtRisk > 0n ? usd(capitalAtRisk) : null,
      confidence,
      expectedScoreAfterAction,
      drivers,
    },
    allocations: allocationAssets > 0n
      ? group(
          (monetaryComplete ? known : valuedItems).flatMap((item) =>
            assetsOf(item.position).map((asset) => ({ key: asset.asset, value: asset.value })),
          ),
          allocationAssets,
        )
      : [],
    protocols: allocationAssets > 0n
      ? group(
          (monetaryComplete ? known : valuedItems).map((item) => ({ key: item.position.protocol.id, value: item.value })),
          allocationAssets,
        )
      : [],
    deployment: {
      deployedBps,
      idleBps,
      lockedBps,
      meaning: monetaryComplete
        ? `${(deployedBps / 100).toFixed(1)}% deployed, ${(idleBps / 100).toFixed(1)}% idle, ${(lockedBps / 100).toFixed(1)}% locked/pending among valued assets.`
        : valuedPositions.length > 0
          ? `${(deployedBps / 100).toFixed(1)}% deployed, ${(idleBps / 100).toFixed(1)}% idle, ${(lockedBps / 100).toFixed(1)}% locked/pending among the explicitly valued subset; unsupported positions are excluded.`
          : "Capital allocation is unavailable because no position has acceptable monetary evidence.",
    },
    scenarios: [10, 20, 30, 50].map((percentage) => {
      const scenarioEnvelope = monetaryComplete
        ? envelope
        : { ...envelope, positions: valuedPositions };
      return scenario(
        scenarioEnvelope,
        monetaryComplete ? totalAssets : valuedAssetsSubtotal,
        monetaryComplete ? totalDebt : valuedDebtSubtotal,
        percentage,
        monetaryComplete || valuedPositions.length > 0,
        monetaryComplete ? "complete-portfolio" : "valued-subset",
        monetaryComplete ? 0 : envelope.positions.length - valuedPositions.length,
      );
    }),
    data: {
      state: warnings.length || !monetaryComplete ? "partial" : "complete",
      lastUpdatedAt: envelope.asOf.observedAt,
      stacksBlockHeight: envelope.asOf.stacksBlockHeight,
      bitcoinBlockHeight: envelope.asOf.bitcoinBlockHeight,
      sources: [
        ...new Set(envelope.positions.flatMap((position) => position.provenance.map((item) => item.source))),
      ],
      warnings,
    },
  };
}
