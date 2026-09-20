import type { PortfolioSummary, Position } from "../../../../packages/domain/src/index.js";
import type { ReactNode } from "react";
import { debtProjection, yieldProjection } from "../lib/earnings.js";
import { formatUsd, humanAmount } from "../lib/portfolio.js";
import { Icon, type IconName } from "./Icons.js";
import { AssetIcon } from "./AssetIcon.js";
import { ProtocolIcon } from "./ProtocolIcon.js";
import type { PortfolioHistoryResponse } from "../api.js";

const overviewPalette = ["#00875f", "#31c996", "#9ce7cf", "#5aaee6", "#f0b14f"];

export function DashboardPanel({
  title,
  meta,
  className = "",
  children,
}: {
  title: string;
  meta?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ov-panel ${className}`}>
      <header>
        <h2>{title}</h2>
        {meta ? <span>{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

export function MetricTile({
  icon,
  assetIcon,
  label,
  value,
  detail,
  progress,
}: {
  icon: IconName;
  assetIcon?: string;
  label: string;
  value: string;
  detail: string;
  progress?: number;
}) {
  return (
    <article className="ov-metric-tile">
      <span className="ov-icon">
        {assetIcon ? <AssetIcon asset={assetIcon} size={36} /> : <Icon name={icon} />}
      </span>
      <div>
        <span className="ov-metric-label">{label}</span>
        <div className="ov-metric-value">
          <strong>{value}</strong>
          {value !== "Unavailable" && value !== "Unsupported" ? <small>USD</small> : null}
        </div>
        <p>{detail}</p>
        {progress != null ? (
          <div className="ov-progress">
            <i style={{ width: `${clamp(progress)}%` }} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function PortfolioPerformance({
  summary,
  history,
}: {
  summary: PortfolioSummary;
  history: PortfolioHistoryResponse | null;
}) {
  const observationCount = history?.observations.length ?? 0;
  const complete = summary.netWorthUsd !== null;
  const displayedNet = summary.netWorthUsd ?? summary.valuedSubtotalUsd;
  const displayedBtc = summary.holdBtcComparisonUsd ?? summary.valuedBtcExposureSubtotalUsd;
  const valuedHistory = (history?.observations ?? [])
    .filter((item) => item.valuedNetSubtotalUsd !== null)
    .slice(-30);
  const historyReady = valuedHistory.length >= 2;
  const historyServiceAvailable = history !== null;
  return (
    <DashboardPanel
      title={historyReady ? "Portfolio value history (canonical)" : "Portfolio history"}
      className="ov-performance"
    >
      <div className="ov-chart-top">
        <div className="ov-chart-legends">
          <ChartLegend
            color="#08a875"
            label={complete ? "Net worth (your portfolio)" : "Valued net subtotal (partial)"}
            value={formatUsd(displayedNet)}
          />
          <ChartLegend
            color="#82b7ac"
            label="Gross BTC-linked exposure"
            value={formatUsd(displayedBtc)}
          />
        </div>
        <div className="ov-periods" aria-label="Performance period">
          {["7D", "30D", "90D", "1Y", "ALL"].map((period) => (
            <button key={period} className={period === "30D" ? "active" : ""} disabled>
              {period}
            </button>
          ))}
        </div>
      </div>
      {historyReady ? (
        <CanonicalValueChart observations={valuedHistory} />
      ) : (
        <div className="ov-chart ov-chart-unavailable" role="status">
          <Icon name="chart" size={28} />
          <strong>
            {historyServiceAvailable
              ? "Historical value needs another canonical observation"
              : "Canonical history service is not active"}
          </strong>
          <p>
            {!historyServiceAvailable
              ? "Start PostgreSQL, ingest canonical Chainhook blocks, and run the portfolio observer. RiskOS will not turn the current value into synthetic history."
              : observationCount === 1
              ? "One reorg-safe baseline is stored. The next canonical snapshot will make value change visible; earned yield remains separate until cash flows are attributed."
              : "RiskOS needs at least two canonical, reorg-safe observations before evaluating change. A single current value is never stretched into synthetic history."}
          </p>
          <div className="ov-chart-note">
            <strong>Current observation only</strong>
            <span>{complete ? "Net worth" : "Valued subtotal"}&nbsp; {formatUsd(displayedNet)}</span>
            <span>BTC-linked&nbsp; {formatUsd(displayedBtc)}</span>
          </div>
        </div>
      )}
    </DashboardPanel>
  );
}

export function CanonicalValueChart({
  observations,
  compact = false,
}: {
  observations: NonNullable<PortfolioHistoryResponse>["observations"];
  compact?: boolean;
}) {
  const values = observations.map((item) => Number(item.valuedNetSubtotalUsd));
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = Math.max(maximum - minimum, maximum * 0.01, 1);
  const points = values
    .map((value, index) => {
      const x = observations.length === 1 ? 50 : (index / (observations.length - 1)) * 100;
      const y = 88 - ((value - minimum) / span) * 68;
      return `${x},${y}`;
    })
    .join(" ");
  const areaPoints = `0,100 ${points} 100,100`;
  const first = observations[0]!;
  const last = observations.at(-1)!;
  const delta = values.at(-1)! - values[0]!;
  const excluded = Math.max(...observations.map((item) => item.excludedPositionCount));
  return (
    <div
      className={`ov-chart ov-canonical-chart${compact ? " ov-canonical-chart-compact" : ""}`}
      role="img"
      aria-label="Canonical valued subtotal history"
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {[20, 42, 64, 86].map((y) => (
          <line key={y} x1="0" x2="100" y1={y} y2={y} className="ov-gridline" />
        ))}
        <polygon points={areaPoints} className="ov-latest-fill" />
        <polyline points={points} className="ov-latest-segment" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ov-history-axis">
        <span>Block {first.blockHeight.toLocaleString()}</span>
        <span>Block {last.blockHeight.toLocaleString()}</span>
      </div>
      {!compact ? (
        <>
          <div className="ov-chart-note">
            <strong>Canonical value change</strong>
            <span>Latest {formatUsd(last.valuedNetSubtotalUsd)}</span>
            <span className={delta < 0 ? "negative" : ""}>
              Change {delta < 0 ? "−" : "+"}
              {formatUsd(String(Math.abs(delta)))}
            </span>
            <small>
              {observations.length} observations · {excluded} excluded
            </small>
          </div>
          <p className="ov-history-disclaimer">
            Value change is not earned yield until deposits, withdrawals, fees, debt flows and price
            movement are attributed.
          </p>
        </>
      ) : null}
    </div>
  );
}

/** Shared stats for compact Positions history card — keeps layout in the host card. */
export function canonicalHistoryDelta(
  observations: NonNullable<PortfolioHistoryResponse>["observations"],
): { delta: number; excluded: number } {
  const values = observations.map((item) => Number(item.valuedNetSubtotalUsd));
  return {
    delta: values.at(-1)! - values[0]!,
    excluded: Math.max(...observations.map((item) => item.excludedPositionCount)),
  };
}

function ChartLegend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="ov-chart-legend">
      <i style={{ background: color }} />
      <span>
        {label}
        <strong>{value}</strong>
      </span>
    </div>
  );
}

export function RiskPosture({
  summary,
  actionableCount,
  liquidityActive,
  liquidityEvidenceAvailable,
  onReview,
}: {
  summary: PortfolioSummary;
  actionableCount: number;
  liquidityActive: boolean;
  liquidityEvidenceAvailable: boolean;
  onReview: () => void;
}) {
  const score = clamp(summary.risk.score);
  const date = new Date(summary.data.lastUpdatedAt);
  const asOf = Number.isNaN(date.valueOf())
    ? summary.data.lastUpdatedAt
    : new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
  return (
    <DashboardPanel title="Risk posture" meta={`As of ${asOf}`} className="ov-risk-posture">
      <div className="ov-risk-body">
        <div
          className="ov-risk-ring"
          style={{ background: `conic-gradient(#008b62 0 ${score}%, #c9f1e3 ${score}% 100%)` }}
        >
          <div>
            <strong>
              {summary.risk.score}
              <small> / 100</small>
            </strong>
            <span>{titleCase(summary.risk.classification)}</span>
          </div>
        </div>
        <div className="ov-risk-facts">
          <RiskFact
            icon="shield"
            title={`${actionableCount} high/critical findings`}
            detail={
              actionableCount
                ? "Review the current evidence before acting."
                : "No high-severity findings in the current evidence set."
            }
          />
          <RiskFact
            icon="droplet"
            title={
              liquidityActive
                ? "Liquidity position is active"
                : liquidityEvidenceAvailable
                  ? "No active liquidity position"
                  : "Liquidity status unavailable"
            }
            detail={
              liquidityActive
                ? "The position is in range and currently eligible to earn trading fees."
                : liquidityEvidenceAvailable
                  ? "No liquidity position is present in the current evidence set."
                  : "Bitflow did not return the range evidence required to determine whether a position is active."
            }
          />
        </div>
      </div>
      <button className="ov-review" onClick={onReview}>
        Review protection <Icon name="arrow" size={16} />
      </button>
    </DashboardPanel>
  );
}

function RiskFact({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div className="ov-risk-fact">
      <span>
        <Icon name={icon} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function AllocationPanel({ summary }: { summary: PortfolioSummary }) {
  const displayedAssets = summary.totalAssetsUsd ?? summary.valuedAssetsSubtotalUsd;
  const partial = summary.totalAssetsUsd === null;
  if (displayedAssets === null || summary.allocations.length === 0) {
    return (
      <DashboardPanel title="Asset allocation (USD)" className="ov-allocation">
        <p className="ov-financial-empty">No supported position currently has acceptable USD evidence.</p>
      </DashboardPanel>
    );
  }
  const segments = summary.allocations.length
    ? summary.allocations
    : [{ key: "Unvalued", valueUsd: "0", percentageBps: 10000, meaning: "" }];
  let cursor = 0;
  const stops = segments
    .map((segment, index) => {
      const start = cursor;
      cursor += segment.percentageBps / 100;
      return `${overviewPalette[index % overviewPalette.length]} ${start}% ${cursor}%`;
    })
    .join(", ");
  return (
    <DashboardPanel title={partial ? "Asset allocation (valued subset)" : "Asset allocation (USD)"} {...(partial ? { meta: "Partial coverage" } : {})} className="ov-allocation">
      <div className="ov-allocation-body">
        <div className="ov-allocation-ring" style={{ background: `conic-gradient(${stops})` }}>
          <div>
            <strong>{formatUsd(displayedAssets)}</strong>
            <span>{partial ? "valued assets" : "assets"}</span>
          </div>
        </div>
        <div className="ov-allocation-list">
          {segments.slice(0, 4).map((segment) => (
            <div key={segment.key}>
              <AssetIcon asset={segment.key} size={18} />
              <b>{assetLabel(segment.key)}</b>
              <strong>{(segment.percentageBps / 100).toFixed(1)}%</strong>
              <span>{formatUsd(segment.valueUsd)}</span>
            </div>
          ))}
        </div>
      </div>
    </DashboardPanel>
  );
}

export function DeploymentPanel({ summary }: { summary: PortfolioSummary }) {
  const displayedDeployed = summary.deployedUsd ?? summary.valuedDeployedSubtotalUsd;
  const displayedIdle = summary.idleUsd ?? summary.valuedIdleSubtotalUsd;
  const partial = summary.totalAssetsUsd === null;
  if (displayedDeployed === null || displayedIdle === null) {
    return (
      <DashboardPanel title="Deployed vs idle (USD)" meta="Unavailable" className="ov-deployment">
        <p className="ov-financial-empty">No supported position currently has acceptable USD evidence.</p>
      </DashboardPanel>
    );
  }
  const deployed = summary.deployment.deployedBps / 100;
  const idle = summary.deployment.idleBps / 100;
  return (
    <DashboardPanel
      title="Deployed vs idle (USD)"
      meta={partial ? `${deployed.toFixed(1)}% of valued assets` : `${deployed.toFixed(1)}% deployed`}
      className="ov-deployment"
    >
      <div className="ov-split-bar">
        <i style={{ width: `${deployed}%` }} />
        <b style={{ width: `${idle}%` }} />
      </div>
      <ValueRow
        label="Deployed"
        value={formatUsd(displayedDeployed)}
        percentage={deployed}
        color="#09a875"
      />
      <ValueRow label="Idle" value={formatUsd(displayedIdle)} percentage={idle} color="#7bdcbf" />
    </DashboardPanel>
  );
}

function ValueRow({
  label,
  value,
  percentage,
  color,
}: {
  label: string;
  value: string;
  percentage: number;
  color: string;
}) {
  return (
    <div className="ov-value-row">
      <i style={{ background: color }} />
      <span>{label}</span>
      <strong>{value}</strong>
      <b>{percentage.toFixed(1)}%</b>
    </div>
  );
}

export function ProtocolPanel({ summary }: { summary: PortfolioSummary }) {
  const partial = summary.totalAssetsUsd === null;
  if (summary.protocols.length === 0) {
    return (
      <DashboardPanel title="Protocol exposure (USD)" className="ov-protocols">
        <p className="ov-financial-empty">No supported protocol position currently has acceptable USD evidence.</p>
      </DashboardPanel>
    );
  }
  const max = Math.max(...summary.protocols.map((item) => item.percentageBps), 1);
  return (
    <DashboardPanel title={partial ? "Protocol exposure (valued subset)" : "Protocol exposure (USD)"} {...(partial ? { meta: "Partial coverage" } : {})} className="ov-protocols">
      <div className="ov-protocol-list">
        {summary.protocols.slice(0, 3).map((item) => (
          <div key={item.key}>
            <span>
              <ProtocolIcon protocol={item.key} size={20} />
              {titleCase(item.key)}
            </span>
            <i>
              <b style={{ width: `${(item.percentageBps / max) * 100}%` }} />
            </i>
            <strong>{formatUsd(item.valueUsd)}</strong>
          </div>
        ))}
      </div>
      <p className="ov-btc-reference">
        BTC ref {summary.btcReferencePriceUsd ? formatUsd(summary.btcReferencePriceUsd) : "unavailable"} ·
        structural compare, not PnL.
      </p>
    </DashboardPanel>
  );
}

export function LiquidityPanel({
  count,
  inRange,
  onOpen,
}: {
  count: number;
  inRange: boolean;
  onOpen: () => void;
}) {
  return (
    <DashboardPanel
      title="Bitflow LP positions"
      meta={`${count} LP${count === 1 ? "" : "s"}`}
      className="ov-liquidity"
    >
      <button className="ov-liquidity-body" onClick={onOpen}>
        <span className="ov-layers">
          <ProtocolIcon protocol="bitflow" size={42} />
        </span>
        <div>
          <strong>
            {count} Bitflow LP{count === 1 ? "" : "s"}
          </strong>
          <p>
            <Icon name="check" size={13} /> {inRange ? "Positions in range" : "Range evidence needs review"}
          </p>
          <p>
            <Icon name="check" size={13} /> Eligible to earn trading fees
          </p>
        </div>
        <Icon name="arrow" size={16} />
      </button>
    </DashboardPanel>
  );
}

export function ZestPositionPanel({
  count,
  hasBorrow,
  hasSupply,
  evidenceAvailable,
  onOpen,
}: {
  count: number;
  hasBorrow: boolean;
  hasSupply: boolean;
  evidenceAvailable: boolean;
  onOpen: () => void;
}) {
  const countLabel = evidenceAvailable ? String(count) : "—";
  return (
    <DashboardPanel
      title="Zest positions"
      meta={evidenceAvailable ? `${count} position${count === 1 ? "" : "s"}` : "Degraded"}
      className="ov-liquidity ov-zest"
    >
      <button className="ov-liquidity-body" onClick={onOpen}>
        <span className="ov-layers">
          <ProtocolIcon protocol="zest" size={42} />
        </span>
        <div>
          <strong>
            {countLabel} Zest position{count === 1 && evidenceAvailable ? "" : "s"}
          </strong>
          {!evidenceAvailable ? (
            <p className="ov-evidence-warning">
              <Icon name="info" size={13} /> Position count unavailable
            </p>
          ) : count === 0 ? (
            <>
              <p>
                <Icon name="check" size={13} /> No active borrow positions
              </p>
              <p>
                <Icon name="check" size={13} /> No active supply positions
              </p>
            </>
          ) : (
            <>
              <p>
                <Icon name="check" size={13} /> {hasBorrow ? "Borrow position active" : "No active borrows"}
              </p>
              <p>
                <Icon name="check" size={13} /> {hasSupply ? "Supply position active" : "No active supplies"}
              </p>
            </>
          )}
        </div>
        <Icon name="arrow" size={16} />
      </button>
    </DashboardPanel>
  );
}

export function PortfolioDebtAndYield({ positions, onOpen }: { positions: Position[]; onOpen: () => void }) {
  const loans = positions.filter((position) => position.type === "lending");
  const yieldPositions = positions.filter(
    (position) => position.type === "supply" || position.type === "liquidity",
  );
  const earningCount = yieldPositions.filter((position) => {
    const projection = yieldProjection(position);
    return projection != null && projection.status !== "idle" && projection.status !== "unavailable";
  }).length;
  const idleCount = yieldPositions.length - earningCount;
  const yieldMeta =
    idleCount > 0
      ? `${earningCount} earning · ${idleCount} idle`
      : `${earningCount} earning position${earningCount === 1 ? "" : "s"}`;
  return (
    <section className="ov-financial-grid" aria-label="Borrowing and earnings">
      <DashboardPanel
        title="Borrowed tokens"
        meta={`${loans.length} debt position${loans.length === 1 ? "" : "s"}`}
        className="ov-financial-panel"
      >
        <div className="ov-financial-list">
          {loans.length ? (
            loans.map((position) => {
              const projected = debtProjection(position);
              const debts = position.legs?.debt ?? [position.debt];
              return (
                <button key={position.id} onClick={onOpen}>
                  <span className="ov-financial-icon">
                    <AssetIcon asset={position.collateral.asset} size={28} />
                  </span>
                  <span className="ov-financial-copy">
                    <small>Against {position.collateral.asset} collateral</small>
                    <strong>
                      {debts
                        .map((debt) => `${humanAmount(debt.amountAtomic, debt.decimals)} ${debt.asset}`)
                        .join(" + ")}
                    </strong>
                    <em>
                      {position.rates
                        ? `${(position.rates.borrowAprBps / 100).toFixed(2)}% variable borrow APR`
                        : "Borrow rate unavailable"}
                    </em>
                  </span>
                  <span className="ov-financial-side">
                    <small>30-day interest</small>
                    <strong>{projected?.interest ?? "Unavailable"}</strong>
                  </span>
                </button>
              );
            })
          ) : (
            <p className="ov-financial-empty">No borrowed-token positions found.</p>
          )}
        </div>
      </DashboardPanel>
      <DashboardPanel title="Fees and lending yield" meta={yieldMeta} className="ov-financial-panel">
        <div className="ov-financial-list">
          {yieldPositions.length ? (
            yieldPositions.map((position) => {
              const projection = yieldProjection(position);
              const label =
                position.type === "supply"
                  ? `${position.asset.asset} supplied`
                  : `${position.token0.asset} / ${position.token1.asset} LP`;
              const projected =
                projection?.projected30dUsd != null
                  ? formatUsd(projection.projected30dUsd)
                  : (projection?.projected30dAsset ??
                    (projection?.status === "paused"
                      ? "Paused out of range"
                      : projection?.status === "idle"
                        ? "No current lending yield"
                        : projection?.status === "reported"
                          ? "Not projected — rate unverified"
                          : "Unavailable"));
              return (
                <button key={position.id} onClick={onOpen}>
                  <span className="ov-financial-icon">
                    <ProtocolIcon protocol={position.protocol.id} size={28} />
                  </span>
                  <span className="ov-financial-copy">
                    <small>{titleCase(position.protocol.id)}</small>
                    <strong>{label}</strong>
                    <em>{projection?.annualRateLabel ?? "Yield rate unavailable"}</em>
                  </span>
                  <span className="ov-financial-side">
                    <small>Earned to date</small>
                    <strong>
                      {projection?.earnedToDateUsd != null
                        ? formatUsd(projection.earnedToDateUsd)
                        : "History required"}
                    </strong>
                    <small>Projected 30 days</small>
                    <strong>{projected}</strong>
                  </span>
                </button>
              );
            })
          ) : (
            <p className="ov-financial-empty">No supply or liquidity positions found.</p>
          )}
        </div>
        {yieldPositions.length ? (
          <p className="ov-financial-note">
            “Earned to date” requires canonical deposits, withdrawals, share-rate changes, fees and incentives;
            a balance increase alone is not called yield. Idle vaults show a verified 0% supply APR because
            borrow demand or utilization is currently zero — not because the rate failed to load.
          </p>
        ) : null}
      </DashboardPanel>
    </section>
  );
}

function clamp(value: number) {
  return Math.min(100, Math.max(0, value));
}
function titleCase(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function assetLabel(value: string) {
  return value.includes("::")
    ? (value
        .split("::")
        .at(-1)
        ?.replace(/-token$/, "") ?? value)
    : value;
}
