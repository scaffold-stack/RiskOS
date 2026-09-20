import { useMemo, useState } from "react";
import type {
  PortfolioSummary,
  Position,
  PositionEnvelope,
  RiskFinding,
} from "../../../../packages/domain/src/index.js";
import { Icon } from "../components/Icons.js";
import { AssetIcon } from "../components/AssetIcon.js";
import { ProtocolIcon } from "../components/ProtocolIcon.js";
import { EmptyState, StatusChip } from "../components/Ui.js";
import { debtProjection, yieldProjection } from "../lib/earnings.js";
import { formatUsd, humanAmount, primaryAsset, severityTone } from "../lib/portfolio.js";
import { operationalWarnings } from "../lib/warnings.js";
import { CanonicalValueChart, canonicalHistoryDelta } from "../components/OverviewVisuals.js";
import type { PortfolioHistoryResponse } from "../api.js";

export type TypeFilter = "all" | "lending" | "liquidity" | "wallet";

export function PositionsPage({
  envelope,
  risks,
  summary,
  history,
  onInspect,
}: {
  envelope: PositionEnvelope | null;
  risks: RiskFinding[];
  summary: PortfolioSummary | null;
  history: PortfolioHistoryResponse | null;
  onInspect: () => void;
}) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [protocolFilter, setProtocolFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const protocols = useMemo(
    () => [...new Set(envelope?.positions.map((position) => protocolName(position)) ?? [])],
    [envelope],
  );
  const visible = useMemo(
    () =>
      envelope?.positions.filter((position) => {
        const risk = risks.find((item) => item.positionId === position.id);
        const text = `${positionLabel(position)} ${protocolName(position)} ${position.type}`.toLowerCase();
        return (
          matchesTypeFilter(position, typeFilter) &&
          (protocolFilter === "all" || protocolName(position) === protocolFilter) &&
          (riskFilter === "all" || (risk?.severity ?? "low") === riskFilter) &&
          text.includes(query.trim().toLowerCase())
        );
      }) ?? [],
    [envelope, protocolFilter, query, riskFilter, risks, typeFilter],
  );
  const selected =
    visible.find((position) => position.id === selectedId) ??
    visible.find((position) => position.type === "liquidity") ??
    visible[0] ??
    null;

  if (!envelope) {
    return (
      <div className="page-state-stage">
        <EmptyState
          title="No portfolio loaded"
          description="Inspect an address from Overview to populate normalized positions with provenance."
          action={
            <button className="btn primary" onClick={onInspect}>
              Inspect address
            </button>
          }
        />
      </div>
    );
  }

  const qualityCounts = envelope.positions.reduce<Record<Position["confidence"]["state"], number>>(
    (counts, position) => ({
      ...counts,
      [position.confidence.state]: counts[position.confidence.state] + 1,
    }),
    { verified: 0, estimated: 0, degraded: 0, unsupported: 0 },
  );
  const qualitySummary = (Object.entries(qualityCounts) as Array<[Position["confidence"]["state"], number]>)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(" · ");
  const deployedPct = (summary?.deployment.deployedBps ?? 0) / 100;
  const idlePct = (summary?.deployment.idleBps ?? 0) / 100;
  const lockedPct = (summary?.deployment.lockedBps ?? 0) / 100;
  const monetaryAvailable = summary?.totalAssetsUsd != null;
  const valuedCapitalAvailable = summary?.valuedAssetsSubtotalUsd != null;
  const displayedAssets = summary?.totalAssetsUsd ?? summary?.valuedAssetsSubtotalUsd;
  const displayedDebt = summary?.totalDebtUsd ?? summary?.valuedDebtSubtotalUsd;
  const displayedNet = summary?.netWorthUsd ?? summary?.valuedSubtotalUsd;
  const debtLegs = envelope.positions.flatMap((position) =>
    position.type === "lending" ? (position.legs?.debt ?? [position.debt]) : [],
  );
  const incompleteDebtEvidence = debtLegs.some((leg) => leg.valueUsd === null);
  const allValuedPositionsVerified =
    (summary?.valuedSubtotalPositionCount ?? 0) > 0 &&
    summary?.valuedSubtotalPositionCount === summary?.verifiedSubtotalPositionCount;
  const positionSummaryValue = monetaryAvailable
    ? summary?.totalAssetsUsd
    : summary?.valuedSubtotalUsd ?? summary?.verifiedSubtotalUsd;
  const positionSummaryLabel = monetaryAvailable
    ? "Total value"
    : allValuedPositionsVerified && summary?.verifiedSubtotalUsd != null
      ? "Verified net subtotal"
      : summary?.valuedSubtotalUsd != null
        ? "Valued net subtotal"
        : "Total value";

  return (
    <div className="positions-dashboard">
      <section className="pos-heading-row">
        <div>
          <h1>Positions</h1>
          <p>Where every unit of capital sits, what it earns and what can affect it.</p>
        </div>
        <div className="pos-filters">
          <label className="pos-search">
            <Icon name="search" size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search positions…"
              aria-label="Search positions"
            />
          </label>
          <label>
            <span>Protocol</span>
            <select
              value={protocolFilter}
              onChange={(event) => setProtocolFilter(event.target.value)}
              aria-label="Protocol filter"
            >
              <option value="all">All</option>
              {protocols.map((protocol) => (
                <option key={protocol}>{protocol}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Risk</span>
            <select
              value={riskFilter}
              onChange={(event) => setRiskFilter(event.target.value)}
              aria-label="Risk filter"
            >
              <option value="all">All</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
        </div>
      </section>

      <div className="pos-tabs" role="tablist" aria-label="Position filters">
        {(["all", "lending", "liquidity", "wallet"] as TypeFilter[]).map((item) => (
          <button
            key={item}
            className={typeFilter === item ? "active" : ""}
            onClick={() => setTypeFilter(item)}
            role="tab"
            aria-selected={typeFilter === item}
          >
            {item === "all" ? "All positions" : titleCase(item)}
          </button>
        ))}
      </div>

      <section className="pos-summary-strip" aria-label="Position summary">
        <SummaryCell label={positionSummaryLabel} value={formatUsd(positionSummaryValue)} />
        <SummaryCell
          label={`${envelope.positions.length} positions`}
          value={`Across ${protocols.length} protocols`}
          compact
        />
        <SummaryCell
          label="Deployed capital"
          value={
            valuedCapitalAvailable
              ? `${formatUsd(summary?.deployedUsd ?? summary?.valuedDeployedSubtotalUsd)} · ${deployedPct.toFixed(1)}%`
              : "Unavailable"
          }
          tone="good"
        />
        <SummaryCell
          label="Idle capital"
          value={
            valuedCapitalAvailable
              ? `${formatUsd(summary?.idleUsd ?? summary?.valuedIdleSubtotalUsd)} · ${idlePct.toFixed(1)}%`
              : "Unavailable"
          }
          tone="good"
        />
        <SummaryCell
          label="Data quality"
          value={qualitySummary || "No evidence"}
          tone={qualityCounts.verified === envelope.positions.length ? "good" : "caution"}
        />
      </section>

      <section className="pos-allocation-card">
        <div className="pos-allocation-heading">
          <h2>Capital allocation</h2>
          {valuedCapitalAvailable ? (
            <p className="pos-net-reconciliation">
              <span>Valued assets <strong>{formatUsd(displayedAssets)}</strong></span>
              <b>−</b>
              <span>
                {incompleteDebtEvidence ? "Fully valued debt" : "Valued debt"}{" "}
                <strong>{formatUsd(displayedDebt)}</strong>
                {incompleteDebtEvidence ? <small>Incomplete debt legs excluded</small> : null}
              </span>
              <b>=</b>
              <span>Net subtotal <strong>{formatUsd(displayedNet)}</strong></span>
            </p>
          ) : null}
        </div>
        {valuedCapitalAvailable ? <div className="pos-capital-bar">
          <i style={{ width: `${deployedPct}%` }} />
          <b style={{ width: `${idlePct}%` }} />
          <em style={{ width: `${lockedPct}%` }} />
        </div> : <p className="ov-financial-empty">No supported position currently has acceptable USD evidence.</p>}
        {valuedCapitalAvailable ? <div className="pos-capital-legend">
          <span>
            <i />
            Deployed
            <strong>
              {deployedPct.toFixed(1)}% &nbsp; {formatUsd(summary?.deployedUsd ?? summary?.valuedDeployedSubtotalUsd)}
            </strong>
          </span>
          <span>
            <i />
            Wallet / idle
            <strong>
              {idlePct.toFixed(1)}% &nbsp; {formatUsd(summary?.idleUsd ?? summary?.valuedIdleSubtotalUsd)}
            </strong>
          </span>
          <span className="locked">
            <i />
            PoX locked / pending
            <strong>
              {lockedPct.toFixed(1)}% &nbsp; {formatUsd(summary?.lockedOrPendingUsd ?? summary?.valuedLockedSubtotalUsd)}
            </strong>
          </span>
        </div> : null}
      </section>

      <section className="pos-primary-grid">
        <section className="pos-table-card">
          <header>
            <h2>Unified positions ({visible.length})</h2>
          </header>
          {visible.length ? (
            <div className="pos-table-wrap">
              <table className="pos-table">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Protocol / type</th>
                    <th>Balance</th>
                    <th>Debt / earnings</th>
                    <th>USD value</th>
                    <th>Capital state</th>
                    <th>Risk</th>
                    <th>Data quality</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((position) => {
                    const risk = risks.find((item) => item.positionId === position.id);
                    return (
                      <tr
                        key={position.id}
                        className={selected?.id === position.id ? "selected" : ""}
                        onClick={() => setSelectedId(position.id)}
                      >
                        <td>
                          <PositionIdentity position={position} />
                        </td>
                        <td>
                          <div className="pos-protocol">
                            <ProtocolIcon protocol={position.protocol.id} size={22} />
                            <span>
                              <strong>{protocolName(position)}</strong>
                              <small>{titleCase(position.type)}</small>
                            </span>
                          </div>
                        </td>
                        <td className="mono pos-col-balance" title={positionBalance(position, false)}>
                          <span>{positionBalance(position)}</span>
                        </td>
                        <td className="pos-economics-cell pos-col-earnings">{positionEconomicsHeadline(position)}</td>
                        <td className="mono">{positionUsdDisplay(position)}</td>
                        <td className="pos-col-state">
                          <StatusChip tone="healthy">{capitalState(position)}</StatusChip>
                        </td>
                        <td>
                          <StatusChip tone={severityTone(risk?.severity)}>
                            {titleCase(risk?.severity ?? "low")}
                          </StatusChip>
                        </td>
                        <td>
                          <StatusChip tone={qualityTone(position)}>
                            {titleCase(position.confidence.state)}
                          </StatusChip>
                        </td>
                        <td>•••</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="pos-empty">No positions match the selected filters.</p>
          )}
        </section>
        <PositionDetail
          position={selected}
          risk={selected ? risks.find((item) => item.positionId === selected.id) : undefined}
        />
      </section>

      <section className="pos-bottom-grid">
        <CompositionCard summary={summary} />
        <LocationCard summary={summary} />
        <HistoryCard history={history} />
        <QualityCard envelope={envelope} />
      </section>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  compact = false,
  tone = "",
}: {
  label: string;
  value: string;
  compact?: boolean;
  tone?: string;
}) {
  return (
    <div className={`pos-summary-cell ${tone}`}>
      <span>
        {label} <Icon name="info" size={12} />
      </span>
      <strong className={compact ? "compact" : ""}>{value}</strong>
    </div>
  );
}

function PositionIdentity({ position }: { position: Position }) {
  const label = positionLabel(position);
  return (
    <div className="pos-identity" title={primaryAssetName(position)}>
      <AssetIcon asset={primaryAssetName(position)} />
      <strong>{label}</strong>
    </div>
  );
}

function PositionDetail({ position, risk }: { position: Position | null; risk: RiskFinding | undefined }) {
  if (!position)
    return (
      <aside className="pos-detail-card">
        <p className="pos-empty">Select a position to inspect its evidence.</p>
      </aside>
    );
  const provenance = position.provenance[0];
  const age = provenance
    ? Math.max(0, Math.round((Date.now() - new Date(provenance.observedAt).valueOf()) / 1000))
    : null;
  return (
    <aside className="pos-detail-card">
      <header>
        <ProtocolIcon protocol={position.protocol.id} size={34} />
        <div>
          <h2>
            {protocolName(position)} {position.type} position
          </h2>
          <p>
            {capitalState(position)} ·{" "}
            {position.confidence.state === "verified" ? "Verified evidence" : "Evidence estimated"}
          </p>
        </div>
        <button aria-label="Position menu">•••</button>
      </header>
      <div className="pos-detail-metrics">
        <div>
          <span>Current value</span>
          <strong>{positionUsdDisplay(position)}</strong>
          <small>{positionBalance(position)}</small>
        </div>
        <div>
          <span>Evidence age</span>
          <strong>{age == null ? "No timestamp" : age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`}</strong>
        </div>
        <div>
          <span>Freshness budget</span>
          <strong>300s</strong>
        </div>
        <div>
          <span>Data quality</span>
          <StatusChip tone={qualityTone(position)}>{titleCase(position.confidence.state)}</StatusChip>
        </div>
      </div>
      {position.type === "liquidity" ? (
        <LiquidityDetail position={position} />
      ) : (
        <GeneralDetail position={position} risk={risk} />
      )}
      <PositionEconomics position={position} />
      <EvidenceFooter position={position} />
    </aside>
  );
}

function EvidenceFooter({ position }: { position: Position }) {
  const latest = position.provenance[0];
  const valuations = positionAssets(position)
    .flatMap((asset) => (asset.valuation ? [{ asset: asset.asset, ...asset.valuation }] : []))
    .filter(
      (valuation, index, values) =>
        values.findIndex(
          (candidate) => candidate.asset === valuation.asset && candidate.source === valuation.source,
        ) === index,
    );
  return (
    <div className="pos-evidence-stack">
      <div className="pos-evidence-footer">
        <span>
          <Icon name="shield" size={15} />
        </span>
        <div>
          <strong>Latest position evidence</strong>
          <p>
            {latest?.source ?? "Source unavailable"}
            {latest?.blockHeight != null ? ` · Block ${latest.blockHeight.toLocaleString()}` : ""}
            {latest?.observedAt ? ` · ${new Date(latest.observedAt).toLocaleString()}` : ""}
          </p>
        </div>
      </div>
      {valuations.length ? (
        <div className="pos-valuation-evidence">
          <strong>USD valuation evidence</strong>
          {valuations.map((valuation) => (
            <p key={`${valuation.asset}:${valuation.source}`} title={valuation.meaning}>
              <span>{valuation.asset}</span>
              <b>${valuation.priceUsd}</b>
              <small>
                {valuation.source.replaceAll("-", " ")} · {Math.round(valuation.confidence * 100)}% source
                confidence
              </small>
            </p>
          ))}
        </div>
      ) : (
        <div className="pos-valuation-evidence unavailable">
          <strong>{position.confidence.state === "unsupported" ? "USD valuation unsupported" : "USD valuation unavailable"}</strong>
          <p>{position.confidence.state === "unsupported"
            ? "This asset has no approved RiskOS market mapping. Its raw balance is visible and excluded from monetary totals."
            : "No acceptable fresh market or oracle observation is attached to this supported position."}</p>
        </div>
      )}
    </div>
  );
}

function positionAssets(position: Position) {
  if (position.type === "wallet" || position.type === "supply") return [position.asset];
  if (position.type === "lending") {
    return position.legs
      ? [...position.legs.collateral, ...position.legs.debt]
      : [position.collateral, position.debt];
  }
  return [position.token0, position.token1];
}

function LiquidityDetail({ position }: { position: Extract<Position, { type: "liquidity" }> }) {
  const lower = Number(position.lowerPrice);
  const upper = Number(position.upperPrice);
  const current = Number(position.currentPrice);
  const marker = upper > lower ? Math.min(100, Math.max(0, ((current - lower) / (upper - lower)) * 100)) : 50;
  const inRange = current >= lower && current <= upper;
  return (
    <div className="pos-range">
      <h3>
        Concentrated liquidity range <Icon name="info" size={12} />
      </h3>
      <div className="pos-range-labels">
        <span>Lower bound</span>
        <span>Current price</span>
        <span>Upper bound</span>
      </div>
      <div className="pos-range-track">
        <i />
        <b style={{ left: `${marker}%` }} />
      </div>
      <div className="pos-range-values">
        <span>{position.lowerPrice}</span>
        <span>{position.currentPrice}</span>
        <span>{position.upperPrice}</span>
      </div>
      <div className="pos-detail-boxes">
        <div>
          <span>Impermanent loss exposure</span>
          <strong>{inRange ? "Low" : "Review"}</strong>
        </div>
        <div>
          <span>Exit liquidity</span>
          <strong>{position.exitSlippageBps == null ? "Quote required" : "Available"}</strong>
        </div>
        <div>
          <span>Slippage quote</span>
          <strong>
            {position.exitSlippageBps == null
              ? "Refresh required"
              : `${(position.exitSlippageBps / 100).toFixed(2)}%`}
          </strong>
        </div>
      </div>
    </div>
  );
}

function GeneralDetail({ position, risk }: { position: Position; risk: RiskFinding | undefined }) {
  return (
    <div className="pos-general-detail">
      <h3>Position evidence</h3>
      <p>{position.confidence.reasons[0] ?? "Canonical position evidence is available."}</p>
      <div className="pos-detail-boxes">
        <div>
          <span>Position type</span>
          <strong>{titleCase(position.type)}</strong>
        </div>
        <div>
          <span>Risk posture</span>
          <strong>{titleCase(risk?.severity ?? "low")}</strong>
        </div>
        <div>
          <span>Evidence sources</span>
          <strong>{position.provenance.length}</strong>
        </div>
      </div>
    </div>
  );
}

function PositionEconomics({ position }: { position: Position }) {
  if (position.type === "wallet") return null;
  if (position.type === "lending") {
    const projection = debtProjection(position);
    const debtLegs = position.legs?.debt ?? [position.debt];
    return (
      <section className="pos-economics-panel">
        <header>
          <div>
            <h3>Borrowed tokens</h3>
            <p>Liability secured by this position’s collateral.</p>
          </div>
          <StatusChip tone="caution">Debt accruing</StatusChip>
        </header>
        <div className="pos-economics-grid">
          <EconomicsDatum
            label="Outstanding debt"
            value={debtLegs
              .map((debt) => `${humanAmount(debt.amountAtomic, debt.decimals)} ${debt.asset}`)
              .join(" + ")}
            detail={formatUsd(sumPositionLegUsd(debtLegs))}
          />
          <EconomicsDatum
            label="Borrow rate"
            value={position.rates ? `${(position.rates.borrowAprBps / 100).toFixed(2)}% APR` : "Unavailable"}
            detail="Variable protocol rate"
          />
          <EconomicsDatum
            label="Projected interest (30d)"
            value={projection?.interest ?? "Unavailable"}
            detail={projection ? `Projected total: ${projection.total}` : "Requires live vault-rate evidence"}
          />
        </div>
        {projection ? <p className="pos-economics-note">Assumption: {projection.assumption}</p> : null}
      </section>
    );
  }

  const projection = yieldProjection(position);
  const projectedValue =
    projection?.projected30dUsd != null
      ? formatUsd(projection.projected30dUsd)
      : (projection?.projected30dAsset ??
        (projection?.status === "paused"
          ? "Paused out of range"
          : projection?.status === "reported"
            ? "Not projected"
            : "Unavailable"));
  return (
    <section className="pos-economics-panel">
      <header>
        <div>
          <h3>{position.type === "supply" ? "Lending yield" : "LP fees and yield"}</h3>
          <p>
            {position.type === "supply"
              ? "Interest earned by supplying assets."
              : "Provider earnings associated with this liquidity position."}
          </p>
        </div>
        <StatusChip
          tone={
            projection?.status === "earning"
              ? "healthy"
              : projection?.status === "losing"
                ? "critical"
              : projection?.status === "paused" || projection?.status === "idle"
                ? "caution"
                : projection?.status === "reported"
                  ? "uncertain"
                  : "uncertain"
          }
        >
          {projection?.status === "earning"
            ? "Earning"
            : projection?.status === "idle"
              ? "Idle vault"
            : projection?.status === "losing"
              ? "Loss observed"
            : projection?.status === "paused"
              ? "Out of range"
              : projection?.status === "reported"
                ? "Reported rate"
                : "Rate unavailable"}
        </StatusChip>
      </header>
      <div className="pos-economics-grid">
        <EconomicsDatum
          label="Current annualized rate"
          value={projection?.annualRateLabel ?? "Unavailable"}
          detail="Variable; not guaranteed"
        />
        <EconomicsDatum
          label="Earned to date"
          value={projection?.earnedToDateUsd != null ? formatUsd(projection.earnedToDateUsd) : "History required"}
          detail="Requires a reconciled deposit or cost-basis checkpoint"
        />
        <EconomicsDatum
          label="Projected earnings (30d)"
          value={projectedValue}
          detail={
            projection?.status === "idle"
              ? "Vault utilization is currently zero; no supply interest accrues until borrowers appear"
              : projection?.status === "reported"
              ? "Uses a current official provider rate; not verified from canonical reward events"
              : (projection?.projected30dAsset ??
                "Based on current valued position and verified annualized rate")
          }
        />
      </div>
      <p className="pos-economics-note">
        {projection?.meaning ?? "No protocol yield evidence is available for this position."}
      </p>
    </section>
  );
}

function EconomicsDatum({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function CompositionCard({ summary }: { summary: PortfolioSummary | null }) {
  const allocations = summary?.allocations ?? [];
  let cursor = 0;
  const colors = ["#ffa034", "#2f91ef", "#7538e8", "#dfe6e3"];
  const stops =
    allocations
      .map((item, index) => {
        const start = cursor;
        cursor += item.percentageBps / 100;
        return `${colors[index % colors.length]} ${start}% ${cursor}%`;
      })
      .join(", ") || "#dfeee8 0 100%";
  const displayedAssets = summary?.totalAssetsUsd ?? summary?.valuedAssetsSubtotalUsd;
  const partial = summary?.totalAssetsUsd == null;
  return (
    <section className="pos-mini-card">
      <h2>
        Portfolio composition <Icon name="info" size={12} />
      </h2>
      <div className="pos-composition">
        <div className="pos-composition-ring" style={{ background: `conic-gradient(${stops})` }}>
          <div>
            <strong>{formatUsd(displayedAssets)}</strong>
            <span>{partial ? "Valued subset" : "Total value"}</span>
          </div>
        </div>
        <div>
          {allocations.slice(0, 4).map((item) => (
            <p key={item.key}>
              <AssetIcon asset={item.key} size={16} />
              <span>{shortAsset(item.key)}</span>
              <b>{(item.percentageBps / 100).toFixed(1)}%</b>
              <small>{formatUsd(item.valueUsd)}</small>
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}

function LocationCard({ summary }: { summary: PortfolioSummary | null }) {
  const deployed = (summary?.deployment.deployedBps ?? 0) / 100;
  const idle = (summary?.deployment.idleBps ?? 0) / 100;
  const locked = (summary?.deployment.lockedBps ?? 0) / 100;
  return (
    <section className="pos-mini-card">
      <h2>
        Capital location <Icon name="info" size={12} />
      </h2>
      <div className="pos-location-bar">
        <i style={{ width: `${deployed}%` }}>{deployed.toFixed(1)}%</i>
        <b style={{ width: `${idle}%` }}>{idle.toFixed(1)}%</b>
        <em style={{ width: `${locked}%` }}>{locked.toFixed(1)}%</em>
      </div>
      <p className="pos-location-row">
        <i />
        Deployed<strong>{formatUsd(summary?.deployedUsd ?? summary?.valuedDeployedSubtotalUsd)}</strong>
      </p>
      <p className="pos-location-row idle">
        <i />
        Wallet / idle<strong>{formatUsd(summary?.idleUsd ?? summary?.valuedIdleSubtotalUsd)}</strong>
      </p>
      <p className="pos-location-row locked">
        <i />
        PoX locked / pending<strong>{formatUsd(summary?.lockedOrPendingUsd ?? summary?.valuedLockedSubtotalUsd)}</strong>
      </p>
    </section>
  );
}
function HistoryCard({ history }: { history: PortfolioHistoryResponse | null }) {
  const valuedHistory = (history?.observations ?? [])
    .filter((item) => item.valuedNetSubtotalUsd !== null)
    .slice(-30);
  const cashFlowCount = history?.cashFlows.length ?? 0;
  const historyReady = valuedHistory.length >= 2;
  const latest = valuedHistory.at(-1);
  const stats = historyReady ? canonicalHistoryDelta(valuedHistory) : null;
  return (
    <section className="pos-mini-card pos-history">
      <h2>
        Position value (30 days) <Icon name="info" size={12} />
      </h2>
      {historyReady && stats ? (
        <div className="pos-history-body">
          <div className="pos-history-summary">
            <strong>{formatUsd(latest?.valuedNetSubtotalUsd)}</strong>
            <span>
              {valuedHistory.length} observations · {cashFlowCount} cash flows
            </span>
          </div>
          <CanonicalValueChart observations={valuedHistory} compact />
          <p className="pos-history-row">
            <i />
            Canonical change
            <strong className={stats.delta < 0 ? "negative" : ""}>
              {stats.delta < 0 ? "−" : "+"}
              {formatUsd(String(Math.abs(stats.delta)))}
            </strong>
          </p>
          <p className="pos-history-row muted">
            <i />
            Excluded legs
            <strong>{stats.excluded}</strong>
          </p>
        </div>
      ) : (
        <div className="pos-history-empty">
          <Icon name="chart" size={22} />
          <strong>
            {history === null
              ? "Canonical history inactive"
              : valuedHistory.length === 1
                ? "Awaiting next observation"
                : "No canonical snapshots yet"}
          </strong>
          <span>
            {cashFlowCount > 0
              ? `${cashFlowCount} cash-flow events stored`
              : "Value history appears after portfolio snapshots are recorded"}
          </span>
        </div>
      )}
    </section>
  );
}
function QualityCard({ envelope }: { envelope: PositionEnvelope }) {
  return (
    <section className="pos-mini-card pos-quality">
      <h2>
        Data quality <Icon name="info" size={12} />
      </h2>
      {envelope.positions.slice(0, 3).map((position) => (
        <p key={position.id}>
          <i className={position.confidence.state} />
          <span>
            <strong>
              {positionLabel(position)} {position.confidence.state}
            </strong>
            <small>{position.confidence.reasons[0]}</small>
          </span>
        </p>
      ))}
      {operationalWarnings(envelope.warnings).slice(0, 2).map((warning) => (
        <p key={warning}>
          <i className="estimated" />
          <span>
            <strong>Provider warning</strong>
            <small>{warning}</small>
          </span>
        </p>
      ))}
    </section>
  );
}

function positionLabel(position: Position): string {
  if (position.type === "liquidity") return `${positionAssetLabel(position.token0.asset)} liquidity`;
  if (position.type === "wallet" && primaryAsset(position).asset === "STX") {
    return position.spendable ? "STX (spendable)" : "STX (PoX locked)";
  }
  return positionAssetLabel(primaryAsset(position).asset);
}
export function positionAssetLabel(asset: string): string {
  const token = asset.includes("::") ? asset.split("::").at(-1) : asset;
  return token?.trim() || asset;
}
function matchesTypeFilter(position: Position, filter: TypeFilter): boolean {
  return positionTypeMatchesFilter(position.type, filter);
}
export function positionTypeMatchesFilter(positionType: Position["type"], filter: TypeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "lending") return positionType === "lending" || positionType === "supply";
  return positionType === filter;
}
function primaryAssetName(position: Position): string {
  return position.type === "liquidity" ? position.token0.asset : primaryAsset(position).asset;
}
function protocolName(position: Position): string {
  return titleCase(position.protocol.id === "stacks" ? "Stacks" : position.protocol.id);
}
function positionBalance(position: Position, compact = true): string {
  if (position.type === "liquidity") {
    const asset = compact ? positionAssetLabel(position.token0.asset) : position.token0.asset;
    return `${humanAmount(position.token0.amountAtomic, position.token0.decimals)} ${asset}`;
  }
  const asset = primaryAsset(position);
  const label = compact ? positionAssetLabel(asset.asset) : asset.asset;
  return `${humanAmount(asset.amountAtomic, asset.decimals)} ${label}`;
}
function positionUsd(position: Position): string | null {
  if (position.type === "liquidity") return addUsd(position.token0.valueUsd, position.token1.valueUsd);
  if (position.type === "lending") {
    const collateral = sumPositionLegUsd(position.legs?.collateral ?? [position.collateral]);
    const debt = sumPositionLegUsd(position.legs?.debt ?? [position.debt]);
    return subtractUsd(collateral, debt);
  }
  return position.asset.valueUsd;
}

function sumPositionLegUsd(legs: Array<{ valueUsd: string | null }>): string | null {
  if (legs.some((leg) => leg.valueUsd === null)) return null;
  return legs.reduce((sum, leg) => sum + Number(leg.valueUsd), 0).toFixed(2);
}
function positionUsdDisplay(position: Position): string {
  if (position.confidence.state === "unsupported") return "Unsupported";
  const value = positionUsd(position);
  return value === null ? "Awaiting quorum" : formatUsd(value);
}
function positionEconomicsHeadline(position: Position): string {
  if (position.type === "lending") {
    const debts = position.legs?.debt ?? [position.debt];
    return debts
      .map(
        (debt) =>
          `${humanAmount(debt.amountAtomic, debt.decimals)} ${positionAssetLabel(debt.asset)} borrowed`,
      )
      .join(" + ");
  }
  const projection = yieldProjection(position);
  if (!projection) return "—";
  if (projection.status === "paused") return "Yield paused · out of range";
  if (projection.status === "idle") return "Idle vault · no borrowers";
  const rate = projection.annualRateLabel.replace(
    / (supply APR|realized APY|provider-reported APY)$/,
    (match) => (match.includes("APR") ? " APR" : " APY"),
  );
  return rate;
}
function addUsd(a: string | null, b: string | null) {
  return a != null && b != null ? (Number(a) + Number(b)).toFixed(2) : null;
}
function subtractUsd(a: string | null, b: string | null) {
  return a != null && b != null ? (Number(a) - Number(b)).toFixed(2) : null;
}
function capitalState(position: Position) {
  return position.type === "wallet"
    ? position.spendable
      ? "Idle"
      : "Locked"
    : position.type === "liquidity"
      ? "Deployed"
      : position.type === "supply"
        ? "Supplied"
        : "Borrowed";
}
function qualityTone(position: Position): "healthy" | "caution" | "uncertain" {
  return position.confidence.state === "verified"
    ? "healthy"
    : position.confidence.state === "unsupported"
      ? "uncertain"
      : "caution";
}
function titleCase(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function shortAsset(value: string) {
  return value.includes("::")
    ? (value
        .split("::")
        .at(-1)
        ?.replace(/-token$/, "") ?? value)
    : value;
}
