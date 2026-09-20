import type {
  PortfolioSummary,
  PositionEnvelope,
  RiskFinding,
} from "../../../../packages/domain/src/index.js";
import {
  AllocationPanel,
  DeploymentPanel,
  LiquidityPanel,
  MetricTile,
  PortfolioPerformance,
  PortfolioDebtAndYield,
  ProtocolPanel,
  RiskPosture,
  ZestPositionPanel,
} from "../components/OverviewVisuals.js";
import { Icon } from "../components/Icons.js";
import { LoadingState } from "../components/Ui.js";
import { formatUsd } from "../lib/portfolio.js";
import type { PortfolioHistoryResponse } from "../api.js";

interface OverviewPageProps {
  address: string;
  addressDraft: string;
  loading: boolean;
  positions: PositionEnvelope | null;
  risks: RiskFinding[];
  summary: PortfolioSummary | null;
  history: PortfolioHistoryResponse | null;
  onInspect: () => void;
  onAddressDraftChange: (value: string) => void;
  onConnect: () => void;
  walletBusy: boolean;
  onNavigate: (route: "positions" | "risk" | "protect" | "alerts") => void;
}

export function OverviewPage(props: OverviewPageProps) {
  const { summary, positions } = props;
  const actionable = props.risks.filter((risk) => risk.severity === "high" || risk.severity === "critical");

  if (props.loading)
    return (
      <div className="overview-loading">
        <LoadingState />
      </div>
    );
  if (!positions || !summary) {
    return (
      <>
        <h1 className="sr-only">Portfolio overview</h1>
        <section className="page-state-stage overview-onboarding">
          <div className="overview-onboarding-content">
            <span className="overview-onboarding-icon">
              <Icon name="overview" size={28} />
            </span>
            <h2>Inspect a Stacks portfolio</h2>
            <p>
              Paste any public Stacks mainnet address to view its positions and risk evidence. A wallet
              connection is optional for read-only analysis.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                props.onInspect();
              }}
            >
              <label htmlFor="portfolio-address">Stacks address</label>
              <div>
                <input
                  id="portfolio-address"
                  aria-label="Portfolio address"
                  value={props.addressDraft}
                  onChange={(event) => props.onAddressDraftChange(event.target.value)}
                  placeholder="SP… or SM…"
                  spellCheck={false}
                  autoComplete="off"
                />
                <button className="btn primary" disabled={!props.addressDraft.trim()}>
                  <Icon name="search" size={17} />
                  Analyze address
                </button>
              </div>
            </form>
            <div className="overview-onboarding-choice">
              <span>or</span>
            </div>
            <button
              className="btn secondary overview-wallet-choice"
              onClick={props.onConnect}
              disabled={props.walletBusy}
            >
              <Icon name="wallet" size={17} />
              {props.walletBusy ? "Connecting wallet…" : "Connect wallet and analyze"}
            </button>
            <small>
              Connecting only proves address ownership. RiskOS never requests your seed phrase or custody of
              funds.
            </small>
          </div>
        </section>
      </>
    );
  }

  const liquidityPositions = positions.positions.filter((position) => position.type === "liquidity");
  const bitflowPositions = liquidityPositions.filter((position) =>
    position.protocol.id.toLowerCase().includes("bitflow"),
  );
  const zestPositions = positions.positions.filter((position) =>
    position.protocol.id.toLowerCase().includes("zest"),
  );
  const inRange =
    bitflowPositions.length > 0 &&
    bitflowPositions.every((position) => {
      const current = Number(position.currentPrice);
      return current >= Number(position.lowerPrice) && current <= Number(position.upperPrice);
    });
  const deployedPct = summary.deployment.deployedBps / 100;
  const idlePct = summary.deployment.idleBps / 100;
  const monetaryAvailable = summary.totalAssetsUsd !== null;
  const displayedDeployed = summary.deployedUsd ?? summary.valuedDeployedSubtotalUsd;
  const displayedIdle = summary.idleUsd ?? summary.valuedIdleSubtotalUsd;
  const displayedBtcExposure = summary.holdBtcComparisonUsd ?? summary.valuedBtcExposureSubtotalUsd;
  const displayedNetVsBtc = summary.holdBtcDeltaUsd ?? summary.valuedNetVsBtcExposureUsd;
  const verifiedSubtotalAvailable = summary.verifiedSubtotalUsd !== null;
  const allValuedPositionsVerified =
    summary.valuedSubtotalPositionCount > 0 &&
    summary.valuedSubtotalPositionCount === summary.verifiedSubtotalPositionCount;
  const unvaluedPositionCount = Math.max(
    0,
    positions.positions.length - summary.valuedSubtotalPositionCount,
  );
  const displayedPortfolioValue = monetaryAvailable
    ? summary.totalAssetsUsd
    : summary.valuedSubtotalUsd ?? summary.verifiedSubtotalUsd;
  const displayedValueLabel = monetaryAvailable
    ? "Portfolio value"
    : allValuedPositionsVerified && verifiedSubtotalAvailable
      ? "Verified net subtotal"
      : summary.valuedSubtotalUsd !== null
        ? "Valued net subtotal"
        : "Portfolio value";
  const warnings = [...new Set([...summary.data.warnings, ...positions.warnings])];
  const zestEvidenceAvailable = !warnings.some((warning) =>
    warning.toLowerCase().includes("zest-v2 adapter degraded"),
  );
  const liquidityEvidenceAvailable = !warnings.some((warning) =>
    warning.toLowerCase().includes("bitflow adapter degraded"),
  );

  return (
    <div className="overview-dashboard">
      <h1 className="sr-only">Portfolio overview</h1>

      <section className="ov-summary-grid" aria-label="Portfolio summary">
        <article className="ov-summary-card">
          <div className="ov-summary-title">
            {displayedValueLabel} <span aria-hidden="true">◉</span>
          </div>
          <div className="ov-hero-value">
            <strong>{formatUsd(displayedPortfolioValue)}</strong>
            {displayedPortfolioValue !== null ? <span>USD</span> : null}
          </div>
          <p>
            <b>
              {monetaryAvailable
                ? `${positions.positions.length} positions`
                : summary.valuedSubtotalUsd !== null
                  ? `${summary.valuedSubtotalPositionCount} valued (${summary.verifiedSubtotalPositionCount} verified) · ${unvaluedPositionCount} unsupported/unvalued`
                  : verifiedSubtotalAvailable
                    ? `${summary.verifiedSubtotalPositionCount} verified · ${summary.missingValuationCount} excluded`
                    : `${summary.missingValuationCount} unsupported or unavailable`}
            </b>
            <i />
            Updated {formatTime(summary.data.lastUpdatedAt)}
          </p>
        </article>

        <article className="ov-summary-card">
          <div className="ov-summary-title">
            Risk score (never alone) <Icon name="info" size={14} />
          </div>
          <div className="ov-risk-score">
            <strong>
              {summary.risk.score} <small>/ 100</small>
            </strong>
            <span className={`ov-health ${summary.risk.classification}`}>
              {titleCase(summary.risk.classification)}
            </span>
          </div>
          <p>
            <b>{Math.round(summary.risk.confidence * 100)}% confidence</b>
            <i />
            {actionable.length} high/critical findings
          </p>
        </article>

        <article className="ov-summary-card ov-position-summary">
          <div className="ov-summary-title">Your position</div>
          <div className="ov-position-answer">
            <Icon name="shield" size={38} />
            <strong>{summary.centralAnswer.safestAction}</strong>
          </div>
          <p>
            <span className="ov-live-dot" />
            {liquidityPositions.length
              ? "Liquidity position is active."
              : liquidityEvidenceAvailable
                ? "No active liquidity position."
                : "Liquidity status unavailable; Bitflow evidence is incomplete."}
          </p>
        </article>
      </section>

      <section className="ov-capital-intelligence" aria-label="Portfolio interpretation">
        <article>
          <span>Where your capital sits</span>
          <strong>{summary.centralAnswer.where}</strong>
        </article>
        <article>
          <span>What it earns</span>
          <strong>{summary.centralAnswer.earning}</strong>
        </article>
        <article>
          <span>What can go wrong</span>
          <strong>{summary.centralAnswer.canGoWrong}</strong>
        </article>
        <article>
          <span>Safest next action</span>
          <strong>{summary.centralAnswer.safestAction}</strong>
        </article>
      </section>

      <section className="ov-main-grid">
        <PortfolioPerformance summary={summary} history={props.history} />
        <RiskPosture
          summary={summary}
          actionableCount={actionable.length}
          liquidityActive={liquidityPositions.length > 0}
          liquidityEvidenceAvailable={liquidityEvidenceAvailable}
          onReview={() => props.onNavigate("protect")}
        />
      </section>

      <section className="ov-metrics-grid" aria-label="Capital metrics">
        <MetricTile
          icon="coins"
          label="Deployed capital"
          value={formatUsd(displayedDeployed)}
          detail={monetaryAvailable ? `${deployedPct.toFixed(1)}% of total assets` : `${deployedPct.toFixed(1)}% of valued assets · partial coverage`}
          {...(displayedDeployed !== null ? { progress: deployedPct } : {})}
        />
        <MetricTile
          icon="droplet"
          label="Idle capital"
          value={formatUsd(displayedIdle)}
          detail={monetaryAvailable ? `${idlePct.toFixed(1)}% of total assets` : `${idlePct.toFixed(1)}% of valued assets · partial coverage`}
          {...(displayedIdle !== null ? { progress: idlePct } : {})}
        />
        <MetricTile
          icon="link"
          assetIcon="BTC"
          label="BTC-linked exposure"
          value={formatUsd(displayedBtcExposure)}
          detail={monetaryAvailable ? "Sum of valued BTC-linked positions" : "BTC-linked exposure in valued positions · partial coverage"}
        />
        <MetricTile
          icon="chart"
          label="Net worth vs BTC exposure"
          value={formatUsd(displayedNetVsBtc)}
          detail={monetaryAvailable ? "Net worth minus gross BTC-linked exposure" : "Valued net subtotal minus valued BTC exposure"}
        />
      </section>

      <PortfolioDebtAndYield positions={positions.positions} onOpen={() => props.onNavigate("positions")} />

      <section className="ov-bottom-grid">
        <AllocationPanel summary={summary} />
        <DeploymentPanel summary={summary} />
        <ProtocolPanel summary={summary} />
        <ZestPositionPanel
          count={zestPositions.length}
          hasBorrow={zestPositions.some((position) => position.type === "lending")}
          hasSupply={zestPositions.some((position) => position.type === "supply")}
          evidenceAvailable={zestEvidenceAvailable}
          onOpen={() => props.onNavigate("positions")}
        />
        <LiquidityPanel
          count={bitflowPositions.length}
          inRange={inRange}
          onOpen={() => props.onNavigate("positions")}
        />
      </section>

      <footer className="ov-data-footer">
        <span>
          Data source: {summary.data.sources.join(", ") || "canonical Stacks data"} <i /> Block:{" "}
          {summary.data.stacksBlockHeight.toLocaleString()} <i /> Updated:{" "}
          {formatDate(summary.data.lastUpdatedAt)}
        </span>
        <span>
          Exact totals require verified quantities and verified values for every asset and debt leg. Incomplete
          totals are withheld, never filled with assumptions.
        </span>
      </footer>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

function titleCase(value: string): string {
  return value.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
