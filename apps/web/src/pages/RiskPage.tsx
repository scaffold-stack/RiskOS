import type {
  LendingPosition,
  LiquidityPosition,
  PortfolioSummary,
  PositionEnvelope,
  RiskFinding,
} from "../../../../packages/domain/src/index.js";
import { AssetIcon } from "../components/AssetIcon.js";
import { Icon } from "../components/Icons.js";
import { ProtocolIcon } from "../components/ProtocolIcon.js";
import { EmptyState, StatusChip } from "../components/Ui.js";
import { formatUsd, humanAmount, severityTone } from "../lib/portfolio.js";

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
  if (!summary || risks.length === 0) return <RiskEmpty summary={summary} onInspect={onInspect} />;
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

  return (
    <main className="risk-dashboard">
      <header className="risk-heading">
        <h1>Risk monitor</h1>
        <p>What can go wrong, how much capital is affected, and what happens if you do nothing?</p>
      </header>
      <section className={`risk-banner ${severityTone(highestSeverity(risks))}`}>
        <span className="risk-banner-mark">{score < 30 ? "✓" : "!"}</span>
        <div>
          <strong>
            {classification} · {score} / 100
          </strong>
          <p>{summary.risk.classificationMeaning}</p>
        </div>
        <p>
          This score reflects stress sensitivity across your positions, not an immediate liquidation event.
        </p>
        <Icon name="info" size={15} />
      </section>
      <section className="risk-metric-grid">
        <RiskMetric
          label="Composite risk"
          value={`${score} / 100`}
          detail={`${classification} — monitor the evidence`}
          tone={score >= 60 ? "bad" : score >= 30 ? "caution" : "good"}
        />
        <RiskMetric
          label="Findings"
          value={String(risks.length)}
          detail="Deterministic rules with evidence"
        />
        <RiskMetric
          label="Risk categories"
          value={String(categories.length)}
          detail={categories.map(titleCase).join(", ")}
        />
        <RiskMetric
          label="Capital at risk"
          value={formatUsd(summary.risk.capitalAtRiskUsd)}
          detail="Positions with high/critical findings"
        />
        <RiskMetric
          label="Model confidence"
          value={`${Math.round(summary.risk.confidence * 100)}%`}
          detail="Across all models"
          tone="good"
        />
      </section>
      <section className="risk-top-grid">
        <RiskComposition score={score} risks={risks} expected={summary.risk.expectedScoreAfterAction} />
        <ProtectionCard risks={risks} lending={lending} onProtect={onProtect} />
      </section>
      <StressScenarios summary={summary} />
      {lending ? <LendingRisk position={lending} risk={lendingRisk} /> : null}
      {liquidity ? <LiquidityRisk position={liquidity} risk={liquidityRisk} /> : null}
      <FindingsTable risks={risks} envelope={envelope} />
      <EvidenceSummary risks={risks} summary={summary} />
    </main>
  );
}

function RiskEmpty({ summary, onInspect }: { summary: PortfolioSummary | null; onInspect: () => void }) {
  return (
    <main className="risk-dashboard">
      <header className="risk-heading">
        <h1>Risk monitor</h1>
        <p>What can go wrong, how much capital is affected, and what happens if you do nothing?</p>
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
                Composite risk {summary.risk.score}/100 · {Math.round(summary.risk.confidence * 100)}% model
                confidence
              </small>
            )
          }
        />
      </section>
    </main>
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
}: {
  score: number;
  risks: RiskFinding[];
  expected: number | null;
}) {
  const categories = [...new Set(risks.map((risk) => risk.category))].map((category) => ({
    category,
    score: Math.max(...risks.filter((risk) => risk.category === category).map((risk) => risk.score)),
  }));
  return (
    <section className="risk-card risk-composition">
      <header>
        <h2>
          Risk composition <Icon name="info" size={12} />
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
          {categories.map((item) => (
            <div key={item.category}>
              <i className="risk-dot" style={{ background: riskColor(item.score) }} />
              <span>{categoryLabel(item.category)}</span>
              <b>{item.score}</b>
              <em>
                <i style={{ width: `${item.score}%`, background: riskColor(item.score) }} />
              </em>
            </div>
          ))}
          <p>
            Expected after protection: <strong>{expected ?? "available after simulation"}</strong>
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

function StressScenarios({ summary }: { summary: PortfolioSummary }) {
  const entries = [
    {
      name: "Current",
      loss: 0,
      net: numeric(summary.netWorthUsd),
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
          <h2>BTC stress scenarios</h2>
          <span>
            How the currently valued portfolio responds when BTC falls while other assumptions remain fixed.
          </span>
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
          <ScenarioCard key={entry.name} {...entry} isBaseline={index === 0} />
        ))}
      </div>
      <footer className="risk-scenario-note">
        <Icon name="info" size={14} />
        <span>
          These are deterministic stress estimates, not price forecasts. Unsupported or unpriced positions
          remain excluded rather than assigned invented values.
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
}: {
  name: string;
  loss: number | null;
  net: number | null;
  affected: number;
  explanation: string;
  isBaseline: boolean;
}) {
  const total = loss != null && net != null ? loss + net : null;
  const lossPercent = total && total > 0 && loss != null ? (loss / total) * 100 : loss === 0 ? 0 : null;
  return (
    <article className="risk-scenario-card" title={explanation}>
      <header>
        <span>BTC price</span>
        <strong>{shockLabel(name)}</strong>
      </header>
      <div className="risk-scenario-values">
        <p>
          <span>Estimated loss</span>
          <strong className="loss">{loss == null ? "Unavailable" : formatUsd(String(loss))}</strong>
        </p>
        <p>
          <span>Portfolio after</span>
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
    </article>
  );
}

function LendingRisk({ position, risk }: { position: LendingPosition; risk: RiskFinding | undefined }) {
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
            <h2>Lending liquidation risk</h2>
            <span>
              {position.collateral.asset} collateral securing {position.debt.asset} debt
            </span>
          </div>
          <StatusChip tone={severityTone(risk?.severity)}>
            {titleCase(risk?.severity ?? "low")} risk
          </StatusChip>
        </div>
        <p>
          Liquidation eligibility begins when the modeled protocol threshold is crossed <Icon name="info" size={12} />
        </p>
      </header>
      <div className="risk-lending-metrics">
        <RiskDatum
          label="Health factor"
          value={health ?? "Unavailable"}
          detail={health && Number(health) > 1 ? "Buffer present" : "Review required"}
        />
        <RiskDatum
          label="LTV"
          value={ltv ? percentDecimal(ltv) : "Unavailable"}
          detail={`Max ${(position.parameters.maximumLtvBps / 100).toFixed(0)}%`}
        />
        <RiskDatum
          label="Liquidation threshold"
          value={`${(position.parameters.liquidationThresholdBps / 100).toFixed(0)}%`}
          detail="Modeled protocol parameter"
        />
        <RiskDatum
          label="Borrow APR"
          value={position.rates ? `${(position.rates.borrowAprBps / 100).toFixed(2)}%` : "Unavailable"}
          detail={position.rates ? "Variable rate" : "Rate evidence missing"}
        />
        <RiskDatum
          label="Supply APR"
          value={position.rates ? `${(position.rates.supplyAprBps / 100).toFixed(2)}%` : "Unavailable"}
          detail={position.rates ? "Current rate" : "Rate evidence missing"}
        />
        <RiskDatum
          label="Projected debt (30d)"
          value={projection ? humanAmount(projection.amountAtomic, position.debt.decimals) : "Unavailable"}
          detail={position.debt.asset}
        />
        <RiskDatum
          label="Liquidation price"
          value={liquidationPrice ? formatUsd(liquidationPrice) : "Unavailable"}
          detail={liquidationPrice ? "Model estimate" : "Invalid or missing inputs"}
          caution={!liquidationPrice}
        />
      </div>
      <div className="risk-lending-charts">
        <HealthChart current={health} risk={risk} />
        <DebtProjection position={position} />
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

function HealthChart({ current, risk }: { current: string | null; risk: RiskFinding | undefined }) {
  const values = [current, ...(risk?.scenarios.map((scenario) => scenario.result) ?? [])].map((value) =>
    value && Number.isFinite(Number(value)) ? Number(value) : null,
  );
  return (
    <div className="risk-mini-chart">
      <header>
        <h3>Health factor vs BTC price shock</h3>
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
                {value?.toFixed(4) ?? "n/a"}
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

function DebtProjection({ position }: { position: LendingPosition }) {
  if (!position.rates)
    return (
      <div className="risk-mini-chart">
        <header>
          <h3>Projected debt growth</h3>
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
        <h3>Projected debt growth ({(position.rates.borrowAprBps / 100).toFixed(2)}% APR)</h3>
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

function LiquidityRisk({ position, risk }: { position: LiquidityPosition; risk: RiskFinding | undefined }) {
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
            <h2>Bitflow concentrated liquidity</h2>
            <span>
              {position.token0.asset} / {position.token1.asset}
            </span>
          </div>
          <StatusChip tone={inRange ? "healthy" : "caution"}>
            {inRange ? "Active · In range" : "Out of range"}
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
          <h3>Distance to range</h3>
          <div>
            <strong>{fromLow == null ? "n/a" : `${fromLow.toFixed(1)}%`}</strong>
            <span>from low</span>
            <strong>{fromHigh == null ? "n/a" : `${fromHigh.toFixed(1)}%`}</strong>
            <span>from high</span>
          </div>
        </div>
        <div className="risk-exit">
          <h3>Exit liquidity</h3>
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
          label="Impermanent-loss exposure"
          value={inRange ? "Monitored" : "Elevated"}
          detail="Track price toward range edges"
        />
        <RiskDatum
          label="Range status"
          value={inRange ? "In range" : "Out of range"}
          detail={inRange ? "Currently earning trading fees" : "Position may be one-sided"}
        />
        <RiskDatum
          label="Exit liquidity"
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

function FindingsTable({ risks, envelope }: { risks: RiskFinding[]; envelope: PositionEnvelope | null }) {
  return (
    <section className="risk-card risk-findings">
      <header>
        <h2>
          Findings, ordered by impact <Icon name="info" size={12} />
        </h2>
      </header>
      <div className="risk-findings-wrap">
        <table>
          <thead>
            <tr>
              <th>Finding</th>
              <th>Severity</th>
              <th>Affected position</th>
              <th>Current evidence</th>
              <th>If ignored</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {[...risks]
              .sort((a, b) => b.score - a.score)
              .map((risk) => {
                const position = envelope?.positions.find((item) => item.id === risk.positionId);
                return (
                  <tr key={risk.riskId}>
                    <td>
                      <strong>{risk.title}</strong>
                    </td>
                    <td>
                      <StatusChip tone={severityTone(risk.severity)}>{titleCase(risk.severity)}</StatusChip>
                    </td>
                    <td>{position ? positionLabel(position) : risk.positionId}</td>
                    <td>
                      {risk.plainMetrics[0]
                        ? `${risk.plainMetrics[0].label}: ${risk.plainMetrics[0].value}`
                        : "Evidence attached"}
                    </td>
                    <td>{risk.ifYouDoNothing}</td>
                    <td>
                      {risk.recommendedActions[0] ? titleCase(risk.recommendedActions[0].type) : "Monitor"}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvidenceSummary({ risks, summary }: { risks: RiskFinding[]; summary: PortfolioSummary }) {
  const models = [...new Map(risks.map((risk) => [`${risk.model.id}@${risk.model.version}`, risk])).values()];
  const expiry = Math.min(...risks.map((risk) => Date.parse(risk.expiresAt)).filter(Number.isFinite));
  return (
    <section className="risk-card risk-evidence-summary">
      <div>
        <h2>
          Model versions and evidence <Icon name="info" size={12} />
        </h2>
        <div className="risk-models">
          {models.map((risk) => (
            <p key={risk.riskId}>
              <strong>
                {risk.model.id}@{risk.model.version}
              </strong>
              <span>{Math.round(risk.confidence.score * 100)}% confidence</span>
            </p>
          ))}
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
        {summary.data.warnings[0] ? <p>{summary.data.warnings[0]}</p> : null}
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
