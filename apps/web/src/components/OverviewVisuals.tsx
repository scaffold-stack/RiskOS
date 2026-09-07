import type { PortfolioSummary, Position } from "../../../../packages/domain/src/index.js";
import type { ReactNode } from "react";
import { debtProjection, yieldProjection } from "../lib/earnings.js";
import { formatUsd, humanAmount } from "../lib/portfolio.js";
import { Icon, type IconName } from "./Icons.js";
import { AssetIcon } from "./AssetIcon.js";
import { ProtocolIcon } from "./ProtocolIcon.js";

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
          <small>USD</small>
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

export function PortfolioPerformance({ summary }: { summary: PortfolioSummary }) {
  return (
    <DashboardPanel title="Portfolio performance (30 days)" className="ov-performance">
      <div className="ov-chart-top">
        <div className="ov-chart-legends">
          <ChartLegend
            color="#08a875"
            label="Net worth (your portfolio)"
            value={formatUsd(summary.netWorthUsd)}
          />
          <ChartLegend
            color="#82b7ac"
            label="Gross BTC-linked exposure"
            value={formatUsd(summary.holdBtcComparisonUsd)}
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
      <div
        className="ov-chart"
        role="img"
        aria-label="Portfolio history is not yet available; latest canonical values are shown"
      >
        <span className="ov-y-title">USD</span>
        <svg viewBox="0 0 900 205" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="latestValueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#22bd89" stopOpacity=".2" />
              <stop offset="1" stopColor="#22bd89" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[22, 72, 122, 172].map((y) => (
            <line key={`h-${y}`} x1="58" x2="890" y1={y} y2={y} className="ov-gridline" />
          ))}
          {[58, 150, 242, 334, 426, 518, 610, 702, 794, 890].map((x) => (
            <line key={`v-${x}`} x1={x} x2={x} y1="22" y2="172" className="ov-gridline" />
          ))}
          <line x1="825" x2="825" y1="12" y2="172" className="ov-current-line" />
          <path d="M58 172 L825 172 L825 82 L890 70 L890 172 Z" fill="url(#latestValueFill)" />
          <path d="M825 82 L890 70" className="ov-latest-segment" />
          <circle cx="825" cy="82" r="5" fill="#09a875" stroke="#fff" strokeWidth="2" />
          <circle cx="890" cy="70" r="4" fill="#09a875" />
        </svg>
        <div className="ov-y-labels">
          <span>$800K</span>
          <span>$600K</span>
          <span>$400K</span>
          <span>$200K</span>
          <span>$0</span>
        </div>
        <div className="ov-x-labels">
          <span>30 days ago</span>
          <span>History begins with canonical snapshots</span>
          <span>Latest</span>
        </div>
        <div className="ov-chart-note">
          <strong>Latest observation</strong>
          <span>Portfolio&nbsp; {formatUsd(summary.netWorthUsd)}</span>
          <span>BTC-linked&nbsp; {formatUsd(summary.holdBtcComparisonUsd)}</span>
        </div>
      </div>
    </DashboardPanel>
  );
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
  onReview,
}: {
  summary: PortfolioSummary;
  actionableCount: number;
  liquidityActive: boolean;
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
            title={liquidityActive ? "Liquidity position is active" : "No active liquidity position"}
            detail={
              liquidityActive
                ? "The position is in range and currently eligible to earn trading fees."
                : "No liquidity position is present in the current evidence set."
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
    <DashboardPanel title="Asset allocation (USD)" className="ov-allocation">
      <div className="ov-allocation-body">
        <div className="ov-allocation-ring" style={{ background: `conic-gradient(${stops})` }}>
          <div>
            <strong>{formatUsd(summary.totalAssetsUsd)}</strong>
            <span>assets</span>
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
  const deployed = summary.deployment.deployedBps / 100;
  const idle = summary.deployment.idleBps / 100;
  return (
    <DashboardPanel
      title="Deployed vs idle (USD)"
      meta={`${deployed.toFixed(1)}% deployed`}
      className="ov-deployment"
    >
      <div className="ov-split-bar">
        <i style={{ width: `${deployed}%` }} />
        <b style={{ width: `${idle}%` }} />
      </div>
      <ValueRow
        label="Deployed"
        value={formatUsd(summary.deployedUsd)}
        percentage={deployed}
        color="#09a875"
      />
      <ValueRow label="Idle" value={formatUsd(summary.idleUsd)} percentage={idle} color="#7bdcbf" />
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
  const max = Math.max(...summary.protocols.map((item) => item.percentageBps), 1);
  return (
    <DashboardPanel title="Protocol exposure (USD)" className="ov-protocols">
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
  const earningPositions = positions.filter(
    (position) => position.type === "supply" || position.type === "liquidity",
  );
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
      <DashboardPanel
        title="Fees and lending yield"
        meta={`${earningPositions.length} earning position${earningPositions.length === 1 ? "" : "s"}`}
        className="ov-financial-panel"
      >
        <div className="ov-financial-list">
          {earningPositions.length ? (
            earningPositions.map((position) => {
              const projection = yieldProjection(position);
              const label =
                position.type === "supply"
                  ? `${position.asset.asset} supplied`
                  : `${position.token0.asset} / ${position.token1.asset} LP`;
              const projected =
                projection?.projected30dUsd != null
                  ? formatUsd(projection.projected30dUsd)
                  : (projection?.projected30dAsset ??
                    (projection?.status === "paused" ? "Paused out of range" : "Unavailable"));
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
                        : "Needs history"}
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
        {earningPositions.length ? (
          <p className="ov-financial-note">
            Projections hold the current evidenced rate and position value constant. They are estimates, not
            guaranteed returns.
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
