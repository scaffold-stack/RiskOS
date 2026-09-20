import type {
  LendingPosition,
  LiquidityPosition,
  PortfolioSummary,
  PositionEnvelope,
  RiskFinding,
} from "../../../../packages/domain/src/index.js";
import { useEffect, useState } from "react";
import { AssetIcon } from "../components/AssetIcon.js";
import { Icon } from "../components/Icons.js";
import { ProtocolIcon } from "../components/ProtocolIcon.js";
import { EmptyState, StatusChip } from "../components/Ui.js";
import { formatUsd, humanAmount, severityTone } from "../lib/portfolio.js";
import { operationalWarnings } from "../lib/warnings.js";

type RiskViewMode = "easy" | "advanced";
const RISK_VIEW_MODE_KEY = "riskos:risk-view-mode";

export function RiskPage({
  risks,
  summary,
  envelope,
  onInspect,
  onProtect,
}: {
  risks: RiskFinding[];
  summary: PortfolioSummary | null;
  envelope: PositionEnvelope | null;
  onInspect: () => void;
  onProtect: () => void;
}) {
  const [viewMode, setViewMode] = useState<RiskViewMode>(() => {
    if (typeof window === "undefined") return "easy";
    return window.localStorage.getItem(RISK_VIEW_MODE_KEY) === "advanced" ? "advanced" : "easy";
  });
  useEffect(() => {
    window.localStorage.setItem(RISK_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);
  const advanced = viewMode === "advanced";

  if (!summary || risks.length === 0) {
    return (
      <RiskEmpty summary={summary} onInspect={onInspect} viewMode={viewMode} onViewModeChange={setViewMode} />
    );
  }
  const score = summary.risk.score;
  const categories = [...new Set(risks.map((risk) => risk.category))];
  const lending =
    envelope?.positions.find((position): position is LendingPosition => position.type === "lending") ?? null;
  const liquidity =
    envelope?.positions.find((position): position is LiquidityPosition => position.type === "liquidity") ??
    null;
  const lendingRisk = lending
    ? risks.find((risk) => risk.positionId === lending.id && risk.category === "liquidation")
    : undefined;
  const liquidityRisk = liquidity
    ? risks.find((risk) => risk.positionId === liquidity.id && risk.category === "liquidity")
    : undefined;
  const classification = riskName(summary.risk.classification);
  const bannerTone = risks.length === 0 ? "healthy" : severityTone(highestSeverity(risks));

  return (
    <main className="risk-dashboard">
      <header className="risk-heading risk-heading-with-mode">
        <div>
          <h1>Risk monitor</h1>
          <p>What can go wrong, how much capital is affected, and what happens if you do nothing?</p>
        </div>
        <RiskModeToggle value={viewMode} onChange={setViewMode} />
      </header>
      <section className="risk-purpose-strip">
        <Icon name="shield" size={18} />
        <p>
          See where your Bitcoin capital is deployed, understand what it earns and what can go wrong, then
          prepare the safest action without giving up custody.
        </p>
      </section>
      <section className={`risk-banner ${bannerTone}`}>
        <span className="risk-banner-mark">{score < 30 ? "✓" : "!"}</span>
        <div>
          <strong>
            {classification} · {score} / 100
          </strong>
          <p>
            {risks.length === 0
              ? "No current findings. BTC stress below still shows how valued Bitcoin exposure would move if price falls."
              : advanced
                ? summary.risk.classificationMeaning
                : riskScoreMeaning(score)}
          </p>
        </div>
        <p>
          {advanced
            ? "This score reflects stress sensitivity across your positions, not an immediate liquidation event."
            : "A high score means more exposure to the issues found below. It does not mean liquidation is happening now."}
        </p>
        <Icon name="info" size={15} />
      </section>
      <section className="risk-metric-grid">
        <RiskMetric
          label={advanced ? "Composite risk" : "Overall risk"}
          value={`${score} / 100`}
          detail={advanced ? `${classification} — monitor the evidence` : riskScoreMeaning(score)}
          tone={score >= 60 ? "bad" : score >= 30 ? "caution" : "good"}
        />
        <RiskMetric
          label={advanced ? "Findings" : "Items to review"}
          value={String(risks.length)}
          detail={advanced ? "Deterministic rules with evidence" : "Backed by current position evidence"}
        />
        <RiskMetric
          label={advanced ? "Risk categories" : "Types of risk"}
          value={String(categories.length)}
          detail={
            categories.length
              ? categories.map(advanced ? titleCase : easyCategoryLabel).join(", ")
              : "None open"
          }
        />
        <RiskMetric
          label={advanced ? "Capital at risk" : "Value in urgent findings"}
          value={formatUsd(summary.risk.capitalAtRiskUsd)}
          detail={advanced ? "Positions with high/critical findings" : "Shown only when reliably valued"}
        />
        <RiskMetric
          label={advanced ? "Model confidence" : "Evidence confidence"}
          value={`${Math.round(summary.risk.confidence * 100)}%`}
          detail={advanced ? "Across all models" : "How complete and fresh the supporting data is"}
          tone="good"
        />
      </section>
      <section className="risk-top-grid">
        <RiskComposition
          score={score}
          risks={risks}
          expected={summary.risk.expectedScoreAfterAction}
          advanced={advanced}
        />
        <ProtectionCard risks={risks} lending={lending} onProtect={onProtect} />
      </section>
      <StressScenarios summary={summary} advanced={advanced} />
      {lending ? <LendingRisk position={lending} risk={lendingRisk} advanced={advanced} /> : null}
      {liquidity ? <LiquidityRisk position={liquidity} risk={liquidityRisk} advanced={advanced} /> : null}
      <FindingsTable risks={risks} envelope={envelope} advanced={advanced} />
      <EvidenceSummary risks={risks} summary={summary} advanced={advanced} />
    </main>
  );
}

function RiskEmpty({
  summary,
  onInspect,
  viewMode,
  onViewModeChange,
}: {
  summary: PortfolioSummary | null;
  onInspect: () => void;
  viewMode: RiskViewMode;
  onViewModeChange: (mode: RiskViewMode) => void;
}) {
  return (
    <main className="risk-dashboard">
      <header className="risk-heading risk-heading-with-mode">
        <div>
          <h1>Risk monitor</h1>
          <p>What can go wrong, how much capital is affected, and what happens if you do nothing?</p>
        </div>
        <RiskModeToggle value={viewMode} onChange={onViewModeChange} />
      </header>
      <section className="page-state-stage with-heading">
        <EmptyState
          title={summary ? "No current risk findings" : "No risk evidence loaded"}
          description={
            summary
              ? "The current canonical evidence set produced no risk findings. Continue monitoring after material price, debt, or protocol-state changes."
              : "Inspect a Stacks address to calculate deterministic findings from current position evidence."
          }
          action={
            !summary ? (
              <button className="btn primary" onClick={onInspect}>
                Inspect address
              </button>
            ) : (
              <small className="empty-evidence-note">
                {viewMode === "advanced" ? "Composite risk" : "Overall risk"} {summary.risk.score}/100 ·{" "}
                {Math.round(summary.risk.confidence * 100)}% {viewMode === "advanced" ? "model" : "evidence"}{" "}
                confidence
              </small>
            )
          }
        />
      </section>
    </main>
  );
}

function RiskModeToggle({
  value,
  onChange,
}: {
  value: RiskViewMode;
  onChange: (mode: RiskViewMode) => void;
}) {
  return (
    <div className="risk-mode-control" aria-label="Risk detail level">
      <span>Detail level</span>
      <div role="group" aria-label="Choose risk detail level">
        <button
          type="button"
          className={value === "easy" ? "active" : ""}
          aria-pressed={value === "easy"}
          onClick={() => onChange("easy")}
        >
          Easy
        </button>
        <button
          type="button"
          className={value === "advanced" ? "active" : ""}
          aria-pressed={value === "advanced"}
          onClick={() => onChange("advanced")}
        >
          Advanced
        </button>
      </div>
    </div>
  );
}

function RiskMetric({
  label,
  value,
  detail,
  tone = "",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <article className="risk-metric">
      <span>
        {label} <Icon name="info" size={12} />
      </span>
      <strong>{value}</strong>
      <p className={tone}>{detail}</p>
    </article>
  );
}

function RiskComposition({
  score,
  risks,
  expected,
  advanced,
}: {
  score: number;
  risks: RiskFinding[];
  expected: number | null;
  advanced: boolean;
}) {
  const categories = [...new Set(risks.map((risk) => risk.category))].map((category) => ({
    category,
    score: Math.max(...risks.filter((risk) => risk.category === category).map((risk) => risk.score)),
  }));
  return (
    <section className="risk-card risk-composition">
      <header>
        <h2>
          {advanced ? "Risk composition" : "What is driving your risk?"} <Icon name="info" size={12} />
        </h2>
      </header>
      <div className="risk-composition-body">
        <div
          className="risk-donut"
          style={{ background: `conic-gradient(${riskColor(score)} 0 ${score}%, #e4f2ed ${score}% 100%)` }}
        >
          <div>
            <strong>{score}</strong>
            <span>/ 100</span>
          </div>
        </div>
        <div className="risk-category-list">
          {categories.length === 0 ? (
            <p>No open finding categories in the current evidence set.</p>
          ) : (
            categories.map((item) => (
              <div key={item.category}>
                <i className="risk-dot" style={{ background: riskColor(item.score) }} />
                <span>{advanced ? categoryLabel(item.category) : easyCategoryLabel(item.category)}</span>
                <b>{item.score}</b>
                <em>
                  <i style={{ width: `${item.score}%`, background: riskColor(item.score) }} />
                </em>
              </div>
            ))
          )}
          <p>
            {advanced ? "Expected after protection" : "Possible score after a simulated action"}:{" "}
            <strong>{expected ?? "available after simulation"}</strong>
          </p>
        </div>
      </div>
    </section>
  );
}

function ProtectionCard({
  risks,
  lending,
  onProtect,
}: {
  risks: RiskFinding[];
  lending: LendingPosition | null;
  onProtect: () => void;
}) {
  const actions = risks.flatMap((risk) => risk.recommendedActions);
  return (
    <section className="risk-card risk-protection">
      <header>
        <h2>
          <Icon name="shield" size={16} /> Recommended protection
        </h2>
      </header>
      <div className="risk-protection-body">
        <p>
          <i className="ok">
            <Icon name="check" size={12} />
          </i>
          {actions.length
            ? "Current actions are evidence-backed and advisory"
            : "No immediate protective action required"}
        </p>
        {actions.slice(0, 2).map((action, index) => (
          <p key={`${action.type}-${index}`}>
            <i>!</i>
            {action.amount ? `${titleCase(action.type)} · ${action.amount}` : titleCase(action.type)}
          </p>
        ))}
        {lending ? (
          <p>
            <i>i</i>Target health is evaluated against the current protocol threshold
          </p>
        ) : null}
        <button onClick={onProtect}>
          Build protection <Icon name="arrow" size={15} />
        </button>
        <small>
          RiskOS prepares unsigned intents and fails closed when required evidence is unavailable.
        </small>
      </div>
    </section>
  );
}

function StressScenarios({ summary, advanced }: { summary: PortfolioSummary; advanced: boolean }) {
  const partial = summary.netWorthUsd === null;
  const excluded = summary.scenarios[0]?.excludedPositionCount ?? summary.missingValuationCount;
  const entries = [
    {
      name: "Current",
      loss: 0,
      net: numeric(summary.netWorthUsd ?? summary.valuedSubtotalUsd),
      affected: summary.valuedPositionCount,
      explanation: "Current valued portfolio before applying a BTC price shock.",
    },
    ...summary.scenarios.map((scenario) => ({
      name: scenario.shock,
      loss: numeric(scenario.estimatedLossUsd),
      net: numeric(scenario.estimatedNetValueUsd),
      affected: scenario.positionsAffected,
      explanation: scenario.explanation,
    })),
  ];
  return (
    <section className="risk-card risk-stress">
      <header>
        <div>
          <h2>{advanced ? "BTC stress scenarios" : "What if Bitcoin falls?"}</h2>
          <span>
            {advanced
              ? "How the currently valued portfolio responds when BTC falls while other assumptions remain fixed."
              : "A what-if test showing the estimated change in your valued positions—not a prediction."}
          </span>
          {partial ? (
            <strong className="risk-scenario-scope">
              Valued subset · {excluded} position{excluded === 1 ? "" : "s"} excluded
            </strong>
          ) : null}
        </div>
        <div className="risk-chart-legend">
          <span>
            <i className="loss" />
            Estimated loss
          </span>
          <span>
            <i className="net" />
            Portfolio after shock
          </span>
        </div>
      </header>
      <div className="risk-scenario-grid">
        {entries.map((entry, index) => (
          <ScenarioCard key={entry.name} {...entry} isBaseline={index === 0} advanced={advanced} />
        ))}
      </div>
      <footer className="risk-scenario-note">
        <Icon name="info" size={14} />
        <span>
          These are deterministic stress estimates, not price forecasts.{" "}
          {partial
            ? `Only accepted valuations are modeled; ${excluded} unsupported or insufficiently evidenced position${excluded === 1 ? " is" : "s are"} excluded, never treated as zero.`
            : "Every portfolio position is included in the modeled totals."}
        </span>
      </footer>
    </section>
  );
}

function ScenarioCard({
  name,
  loss,
  net,
  affected,
  explanation,
  isBaseline,
  advanced,
}: {
  name: string;
  loss: number | null;
  net: number | null;
  affected: number;
  explanation: string;
  isBaseline: boolean;
  advanced: boolean;
}) {
  const total = loss != null && net != null ? loss + net : null;
  const lossPercent = total && total > 0 && loss != null ? (loss / total) * 100 : loss === 0 ? 0 : null;
  return (
    <article className="risk-scenario-card" title={explanation}>
      <header>
        <span>{advanced ? "BTC price" : isBaseline ? "Starting point" : "If BTC falls"}</span>
        <strong>{advanced || isBaseline ? shockLabel(name) : shockLabel(name).replace("-", "")}</strong>
      </header>
      <div className="risk-scenario-values">
        <p>
          <span>{advanced ? "Estimated loss" : "Value decrease"}</span>
          <strong className="loss">{loss == null ? "Unavailable" : formatUsd(String(loss))}</strong>
        </p>
        <p>
          <span>{advanced ? "Portfolio after" : "Estimated value left"}</span>
          <strong className="net">{net == null ? "Unavailable" : formatUsd(String(net))}</strong>
        </p>
      </div>
      <div
        className="risk-scenario-track"
        aria-label={
          lossPercent == null
            ? "Impact unavailable"
            : `${lossPercent.toFixed(1)} percent estimated portfolio loss`
        }
      >
        <i style={{ width: `${lossPercent ?? 0}%` }} />
        <b />
      </div>
      <div className="risk-scenario-foot">
        <strong>
          {lossPercent == null
            ? "Impact unavailable"
            : lossPercent === 0
              ? "No modeled loss"
              : `${lossPercent.toFixed(1)}% of current value`}
        </strong>
        <span>
          {affected} {isBaseline ? "valued" : "BTC-linked"} position{affected === 1 ? "" : "s"}
        </span>
      </div>
      {!advanced && !isBaseline ? (
        <p className="risk-scenario-plain">{plainScenarioMeaning(lossPercent)}</p>
      ) : null}
    </article>
  );
}

function LendingRisk({
  position,
  risk,
  advanced,
}: {
  position: LendingPosition;
  risk: RiskFinding | undefined;
  advanced: boolean;
}) {
  const health = evidence(risk, "healthFactor"),
    ltv = evidence(risk, "ltv"),
    liquidationPrice = evidence(risk, "estimatedLiquidationPriceUsd");
  const projection = position.rates?.debtProjections.find((item) => item.days === 30);
  return (
    <section className="risk-card risk-position-card">
      <header>
        <div className="risk-position-title">
          <AssetIcon asset={position.collateral.asset} size={32} />
          <div>
            <h2>{advanced ? "Lending liquidation risk" : "Loan safety"}</h2>
            <span>
              {position.collateral.asset} collateral securing {position.debt.asset} debt
            </span>
          </div>
          <StatusChip tone={severityTone(risk?.severity)}>
            {titleCase(risk?.severity ?? "low")} risk
          </StatusChip>
        </div>
        <p>
          {advanced
            ? "Liquidation eligibility begins when the modeled protocol threshold is crossed"
            : "Liquidation can begin when the health factor reaches 1.0"}{" "}
          <Icon name="info" size={12} />
        </p>
      </header>
      {!advanced ? <HealthFactorExplainer health={health} position={position} risk={risk} /> : null}
      <div className="risk-lending-metrics">
        <RiskDatum
          label="Health factor"
          value={health ?? "Unavailable"}
          detail={
            advanced
              ? health && Number(health) > 1
                ? "Buffer present"
                : "Review required"
              : healthFactorLabel(health)
          }
        />
        <RiskDatum
          label={advanced ? "LTV" : "Debt vs collateral"}
          value={ltv ? percentDecimal(ltv) : "Unavailable"}
          detail={
            advanced
              ? `Max ${(position.parameters.maximumLtvBps / 100).toFixed(0)}%`
              : `About ${ltv ? percentDecimal(ltv) : "an unknown share"} borrowed per $100 of collateral`
          }
        />
        <RiskDatum
          label={advanced ? "Liquidation threshold" : "Liquidation begins near"}
          value={`${(position.parameters.liquidationThresholdBps / 100).toFixed(0)}%`}
          detail={advanced ? "Modeled protocol parameter" : "Protocol debt-to-collateral boundary"}
        />
        <RiskDatum
          label={advanced ? "Borrow APR" : "Yearly borrowing rate"}
          value={position.rates ? `${(position.rates.borrowAprBps / 100).toFixed(2)}%` : "Unavailable"}
          detail={
            position.rates
              ? advanced
                ? "Variable rate"
                : "Current variable rate; it can change"
              : "Rate evidence missing"
          }
        />
        <RiskDatum
          label={advanced ? "Supply APR" : "Yearly supply yield"}
          value={position.rates ? `${(position.rates.supplyAprBps / 100).toFixed(2)}%` : "Unavailable"}
          detail={
            position.rates
              ? advanced
                ? "Current rate"
                : "Current rate, not a guaranteed return"
              : "Rate evidence missing"
          }
        />
        <RiskDatum
          label={advanced ? "Projected debt (30d)" : "Estimated debt in 30 days"}
          value={projection ? humanAmount(projection.amountAtomic, position.debt.decimals) : "Unavailable"}
          detail={position.debt.asset}
        />
        <RiskDatum
          label={advanced ? "Liquidation price" : "Price where liquidation may begin"}
          value={liquidationPrice ? formatUsd(liquidationPrice) : "Unavailable"}
          detail={
            liquidationPrice
              ? advanced
                ? "Model estimate"
                : "Assumes debt and other inputs do not change"
              : "Invalid or missing inputs"
          }
          caution={!liquidationPrice}
        />
      </div>
      <div className="risk-lending-charts">
        <HealthChart current={health} risk={risk} advanced={advanced} />
        <DebtProjection position={position} advanced={advanced} />
      </div>
      <div className="risk-meaning">
        <Icon name="info" size={15} />
        <strong>What this means:</strong>
        <span>
          Your {position.collateral.asset} collateral secures {position.debt.asset} debt. If collateral falls
          or interest accrues, the health factor can shrink toward 1.0.
        </span>
      </div>
    </section>
  );
}

function RiskDatum({
  label,
  value,
  detail,
  caution = false,
}: {
  label: string;
  value: string;
  detail: string;
  caution?: boolean;
}) {
  return (
    <div className="risk-datum">
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={caution ? "caution" : ""}>{detail}</small>
    </div>
  );
}

function HealthFactorExplainer({
  health,
  position,
  risk,
}: {
  health: string | null;
  position: LendingPosition;
  risk: RiskFinding | undefined;
}) {
  const value = numeric(health);
  const declineRoom = value != null && value > 1 ? (1 - 1 / value) * 100 : value == null ? null : 0;
  const firstUnsafeScenario = risk?.scenarios.find((scenario) => {
    const result = numeric(scenario.result);
    return result != null && result <= 1;
  });
  return (
    <div className={`risk-health-explainer ${healthFactorTone(health)}`}>
      <div className="risk-health-reading">
        <span>Your lending safety reading</span>
        <strong>{health ?? "Unavailable"}</strong>
        <b>{healthFactorLabel(health)}</b>
      </div>
      <div className="risk-health-copy">
        <h3>How to interpret this number</h3>
        {value == null ? (
          <p>
            RiskOS cannot interpret this position until both collateral and debt have accepted USD valuations.
          </p>
        ) : (
          <p>
            <strong>1.0 is the liquidation boundary.</strong> Higher is safer. RiskOS uses 1.35 as its
            monitoring target; your current reading is {value >= 1.35 ? "above" : "below"} that target.
          </p>
        )}
        <p>
          {declineRoom == null
            ? "A price-buffer estimate is withheld because the required inputs are unavailable."
            : `If debt and other inputs stayed unchanged, the modeled collateral could fall about ${declineRoom.toFixed(1)}% before this reading reached 1.0.`}
          {firstUnsafeScenario
            ? ` The ${firstUnsafeScenario.name.toLowerCase()} test reaches the liquidation boundary.`
            : " None of the displayed shock tests reaches 1.0."}
        </p>
        <small>
          Based on the current {position.collateral.asset} collateral, {position.debt.asset} debt, and the
          protocol’s {(position.parameters.liquidationThresholdBps / 100).toFixed(0)}% liquidation threshold.
        </small>
      </div>
    </div>
  );
}

function HealthChart({
  current,
  risk,
  advanced,
}: {
  current: string | null;
  risk: RiskFinding | undefined;
  advanced: boolean;
}) {
  const values = [current, ...(risk?.scenarios.map((scenario) => scenario.result) ?? [])].map((value) =>
    value && Number.isFinite(Number(value)) ? Number(value) : null,
  );
  return (
    <div className="risk-mini-chart">
      <header>
        <h3>
          {advanced ? "Health factor vs BTC price shock" : "How a Bitcoin fall changes your safety buffer"}
        </h3>
        <span>
          <i />
          Health factor <b />
          Target (1.35) <em />
          Liquidation (1.0)
        </span>
      </header>
      {values.some((value) => value != null) ? (
        <div className="risk-health-points">
          {values.map((value, index) => (
            <div key={index}>
              <b style={{ bottom: `${Math.min(100, Math.max(0, ((value ?? 0) / 2) * 100))}%` }}>
                {value?.toFixed(4) ?? "Not modeled"}
              </b>
              <i style={{ height: `${Math.min(100, Math.max(0, ((value ?? 0) / 2) * 100))}%` }} />
              <span>
                {index === 0 ? "Current" : risk?.scenarios[index - 1]?.name.replace("Collateral ", "")}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <Unavailable label="Health scenarios unavailable" />
      )}
    </div>
  );
}

function DebtProjection({ position, advanced }: { position: LendingPosition; advanced: boolean }) {
  if (!position.rates)
    return (
      <div className="risk-mini-chart">
        <header>
          <h3>{advanced ? "Projected debt growth" : "How the debt may grow"}</h3>
        </header>
        <Unavailable label="Debt-rate evidence unavailable" />
      </div>
    );
  const current = Number(
    humanAmount(position.debt.amountAtomic, position.debt.decimals, position.debt.decimals),
  );
  const entries = [
    { days: 0, amount: current },
    ...position.rates.debtProjections.map((item) => ({
      days: item.days,
      amount: Number(humanAmount(item.amountAtomic, position.debt.decimals, position.debt.decimals)),
    })),
  ];
  const max = Math.max(...entries.map((item) => item.amount), 1);
  return (
    <div className="risk-mini-chart">
      <header>
        <h3>
          {advanced ? "Projected debt growth" : "How the debt may grow"} (
          {(position.rates.borrowAprBps / 100).toFixed(2)}% APR)
        </h3>
      </header>
      <div className="risk-debt-bars">
        {entries.map((item) => (
          <div key={item.days}>
            <i style={{ height: `${Math.max(8, (item.amount / max) * 100)}%` }}>
              <b>{item.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
            </i>
            <span>{item.days}d</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiquidityRisk({
  position,
  risk,
  advanced,
}: {
  position: LiquidityPosition;
  risk: RiskFinding | undefined;
  advanced: boolean;
}) {
  const lower = Number(position.lowerPrice),
    upper = Number(position.upperPrice),
    current = Number(position.currentPrice);
  const valid = [lower, upper, current].every(Number.isFinite) && upper > lower;
  const marker = valid ? clamp(((current - lower) / (upper - lower)) * 100) : 50,
    fromLow = valid ? clamp(((current - lower) / current) * 100) : null,
    fromHigh = valid ? clamp(((upper - current) / current) * 100) : null;
  const inRange = valid && current >= lower && current <= upper;
  return (
    <section className="risk-card risk-position-card">
      <header>
        <div className="risk-position-title">
          <ProtocolIcon protocol="bitflow" size={32} />
          <div>
            <h2>{advanced ? "Bitflow concentrated liquidity" : "Bitflow liquidity position"}</h2>
            <span>
              {position.token0.asset} / {position.token1.asset}
            </span>
          </div>
          <StatusChip tone={inRange ? "healthy" : "caution"}>
            {inRange ? (advanced ? "Active · In range" : "Earning fees now") : "Outside earning range"}
          </StatusChip>
          <StatusChip tone={severityTone(risk?.severity)}>
            {titleCase(risk?.severity ?? "low")} risk
          </StatusChip>
        </div>
        <p>Model confidence: {Math.round((risk?.confidence.score ?? position.confidence.score) * 100)}%</p>
      </header>
      <div className="risk-liquidity-grid">
        <div className="risk-range-panel">
          <h3>
            Position range ({position.token1.asset} per {position.token0.asset})
          </h3>
          {valid ? (
            <>
              <div className="risk-range-track">
                <i />
                <b style={{ left: `${marker}%` }} />
              </div>
              <div className="risk-range-labels">
                <span>
                  {position.lowerPrice}
                  <small>Lower bound</small>
                </span>
                <span>
                  {position.currentPrice}
                  <small>Current price</small>
                </span>
                <span>
                  {position.upperPrice}
                  <small>Upper bound</small>
                </span>
              </div>
            </>
          ) : (
            <Unavailable label="Range evidence unavailable" />
          )}
        </div>
        <div className="risk-distance">
          <h3>{advanced ? "Distance to range" : "Room before leaving the earning range"}</h3>
          <div>
            <strong>{fromLow == null ? "Not modeled" : `${fromLow.toFixed(1)}%`}</strong>
            <span>from low</span>
            <strong>{fromHigh == null ? "Not modeled" : `${fromHigh.toFixed(1)}%`}</strong>
            <span>from high</span>
          </div>
        </div>
        <div className="risk-exit">
          <h3>{advanced ? "Exit liquidity" : "Cost to exit now"}</h3>
          <strong>
            {position.exitSlippageBps == null
              ? "Quote unavailable"
              : `${(position.exitSlippageBps / 100).toFixed(2)}% slippage`}
          </strong>
          <p>
            {position.exitSlippageBps == null
              ? "Refresh a live quote before planning an exit."
              : "Estimated cost to remove liquidity at the observed quote."}
          </p>
        </div>
      </div>
      <div className="risk-liquidity-facts">
        <RiskDatum
          label={advanced ? "Impermanent-loss exposure" : "Pool balance can change"}
          value={inRange ? "Monitored" : "Elevated"}
          detail={
            advanced
              ? "Track price toward range edges"
              : "Price movement can leave you holding more of one token"
          }
        />
        <RiskDatum
          label={advanced ? "Range status" : "Fee-earning status"}
          value={inRange ? (advanced ? "In range" : "Earning fees") : "Not earning fees"}
          detail={inRange ? "Currently earning trading fees" : "Position may be one-sided"}
        />
        <RiskDatum
          label={advanced ? "Exit liquidity" : "Current exit estimate"}
          value={
            position.exitSlippageBps == null
              ? "Unknown until quote"
              : `${(position.exitSlippageBps / 100).toFixed(2)}%`
          }
          detail="Quote is time-sensitive"
        />
      </div>
    </section>
  );
}

function FindingsTable({
  risks,
  envelope,
  advanced,
}: {
  risks: RiskFinding[];
  envelope: PositionEnvelope | null;
  advanced: boolean;
}) {
  return (
    <section className="risk-card risk-findings">
      <header>
        <h2>
          {advanced ? "Findings, ordered by impact" : "What needs your attention"}{" "}
          <Icon name="info" size={12} />
        </h2>
      </header>
      <div className="risk-findings-wrap">
        <table>
          <thead>
            <tr>
              <th>{advanced ? "Finding" : "Issue"}</th>
              <th>{advanced ? "Severity" : "Level"}</th>
              <th>{advanced ? "Affected position" : "Where"}</th>
              <th>{advanced ? "Current evidence" : "What we know"}</th>
              <th>{advanced ? "If ignored" : "What could happen"}</th>
              <th>{advanced ? "Action" : "Next step"}</th>
            </tr>
          </thead>
          <tbody>
            {risks.length === 0 ? (
              <tr>
                <td colSpan={6} className="risk-finding-empty">
                  No open findings. Continue monitoring after material price, debt, or protocol-state changes.
                </td>
              </tr>
            ) : (
              [...risks]
                .sort((a, b) => b.score - a.score)
                .map((risk) => {
                  const position = envelope?.positions.find((item) => item.id === risk.positionId);
                  const affectedPosition = position ? positionLabel(position) : risk.positionId;
                  return (
                    <tr key={risk.riskId}>
                      <td className="risk-finding-title">
                        <strong>{risk.title}</strong>
                      </td>
                      <td className="risk-finding-severity">
                        <StatusChip tone={severityTone(risk.severity)}>{titleCase(risk.severity)}</StatusChip>
                      </td>
                      <td className="risk-finding-position" title={affectedPosition}>
                        <span>{compactAssetLabel(affectedPosition)}</span>
                      </td>
                      <td className="risk-finding-evidence">
                        {risk.plainMetrics[0]
                          ? `${risk.plainMetrics[0].label}: ${risk.plainMetrics[0].value}`
                          : "Evidence attached"}
                      </td>
                      <td className="risk-finding-consequence">{risk.ifYouDoNothing}</td>
                      <td className="risk-finding-action">
                        {risk.recommendedActions[0] ? titleCase(risk.recommendedActions[0].type) : "Monitor"}
                      </td>
                    </tr>
                  );
                })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvidenceSummary({
  risks,
  summary,
  advanced,
}: {
  risks: RiskFinding[];
  summary: PortfolioSummary;
  advanced: boolean;
}) {
  const models = [...new Map(risks.map((risk) => [`${risk.model.id}@${risk.model.version}`, risk])).values()];
  const expiryTimes = risks.map((risk) => Date.parse(risk.expiresAt)).filter(Number.isFinite);
  const expiry = expiryTimes.length ? Math.min(...expiryTimes) : Number.NaN;
  return (
    <section className="risk-card risk-evidence-summary">
      <div>
        <h2>
          {advanced ? "Model versions and evidence" : "Can these results be trusted?"}{" "}
          <Icon name="info" size={12} />
        </h2>
        <div className="risk-models">
          {!advanced ? (
            <p className="risk-easy-evidence">
              <strong>{Math.round(summary.risk.confidence * 100)}% evidence confidence</strong>
              <span>
                {summary.data.state === "complete"
                  ? "Required inputs are present and current for this analysis."
                  : "Some inputs are incomplete or degraded; affected calculations are withheld rather than guessed."}
              </span>
            </p>
          ) : models.length === 0 ? (
            <p>
              <strong>No open finding models</strong>
              <span>{Math.round(summary.risk.confidence * 100)}% portfolio model confidence</span>
            </p>
          ) : (
            models.map((risk) => (
              <p key={risk.riskId}>
                <strong>
                  {risk.model.id}@{risk.model.version}
                </strong>
                <span>{Math.round(risk.confidence.score * 100)}% confidence</span>
              </p>
            ))
          )}
          <p>
            <strong>Last updated: {new Date(summary.data.lastUpdatedAt).toLocaleString()}</strong>
            <span>
              {Number.isFinite(expiry)
                ? `Evidence expires: ${new Date(expiry).toLocaleTimeString()}`
                : "Expiry unavailable"}
            </span>
          </p>
        </div>
      </div>
      <aside className={summary.data.state === "complete" ? "healthy" : "caution"}>
        <strong>Calculation health</strong>
        <span>{summary.data.state === "complete" ? "● Healthy" : `● ${titleCase(summary.data.state)}`}</span>
        {operationalWarnings(summary.data.warnings)[0] ? (
          <p>{operationalWarnings(summary.data.warnings)[0]}</p>
        ) : summary.data.state !== "complete" ? (
          <p>
            Exact portfolio totals stay withheld until every position has verified quantity and valuation
            evidence. Valued subsets remain available.
          </p>
        ) : null}
      </aside>
    </section>
  );
}

function Unavailable({ label }: { label: string }) {
  return <div className="risk-unavailable">{label}</div>;
}
function evidence(risk: RiskFinding | undefined, metric: string) {
  return risk?.evidence.find((item) => item.metric === metric)?.value ?? null;
}
function numeric(value: string | null | undefined) {
  const parsed = value == null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function percentDecimal(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : "Unavailable";
}
function clamp(value: number) {
  return Math.min(100, Math.max(0, value));
}
function shockLabel(value: string) {
  if (value === "Current") return "Unchanged";
  const percentage = value.match(/-?\d+(?:\.\d+)?/)?.[0];
  return percentage ? `${percentage}%` : value;
}
function plainScenarioMeaning(lossPercent: number | null) {
  if (lossPercent == null)
    return "This impact is withheld because the required valuation evidence is incomplete.";
  if (lossPercent < 5) return "Small modeled effect on the currently valued portfolio.";
  if (lossPercent < 20) return "Noticeable modeled loss; review exposed positions.";
  if (lossPercent < 40) return "Large modeled loss; your portfolio is meaningfully sensitive to Bitcoin.";
  return "Severe modeled loss; a large share of valued capital follows Bitcoin downward.";
}
function riskScoreMeaning(score: number) {
  if (score >= 80) return "Critical — address the highest-impact issues now";
  if (score >= 60) return "High — ordinary market moves could materially affect positions";
  if (score >= 30) return "Moderate — monitor the identified weak points";
  return "Low — no major issue in the current evidence";
}
export function healthFactorLabel(health: string | null) {
  const value = numeric(health);
  if (value == null) return "Cannot be interpreted without complete valuations";
  if (value <= 1) return "At or beyond the liquidation boundary";
  if (value < 1.1) return "Very small safety buffer";
  if (value < 1.35) return "Below the RiskOS monitoring target";
  if (value < 1.5) return "Above target, with a moderate buffer";
  return "Above target, with a stronger buffer";
}
function healthFactorTone(health: string | null) {
  const value = numeric(health);
  if (value == null || value < 1.1) return "danger";
  if (value < 1.35) return "caution";
  return "healthy";
}
function titleCase(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function categoryLabel(category: RiskFinding["category"]) {
  return category === "liquidation"
    ? "Liquidation (lending)"
    : category === "liquidity"
      ? "Liquidity (concentrated)"
      : titleCase(category);
}
function easyCategoryLabel(category: RiskFinding["category"]) {
  return category === "liquidation"
    ? "Loan liquidation"
    : category === "liquidity"
      ? "Liquidity range"
      : category === "oracle"
        ? "Price or data quality"
        : category === "bridge"
          ? "Bitcoin bridge"
          : category === "unsupported"
            ? "Unsupported exposure"
            : titleCase(category);
}
function riskName(classification: PortfolioSummary["risk"]["classification"]) {
  return classification === "high-risk" ? "High risk" : titleCase(classification);
}

function riskColor(score: number): string {
  if (score >= 80) return "#d6293f";
  if (score >= 60) return "#ef5969";
  if (score >= 30) return "#e6a51c";
  return "#08a875";
}
function highestSeverity(risks: RiskFinding[]): RiskFinding["severity"] {
  const order: RiskFinding["severity"][] = ["info", "low", "medium", "high", "critical"];
  return risks.reduce<RiskFinding["severity"]>(
    (peak, risk) => (order.indexOf(risk.severity) > order.indexOf(peak) ? risk.severity : peak),
    "info",
  );
}
function positionLabel(position: PositionEnvelope["positions"][number]) {
  return position.type === "liquidity"
    ? `${position.token0.asset} / ${position.token1.asset}`
    : position.type === "lending"
      ? `${position.collateral.asset} / ${position.debt.asset}`
      : position.asset.asset;
}

export function compactAssetLabel(label: string): string {
  if (!label.includes("::")) return label;
  const tokenName = label.split("::").at(-1)?.trim();
  return tokenName || label;
}
