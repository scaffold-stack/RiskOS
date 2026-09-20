import { useEffect, useMemo, useState } from "react";
import type {
  LendingPosition,
  Position,
  PositionEnvelope,
  RiskFinding,
  TransactionIntent,
} from "../../../../packages/domain/src/index.js";
import { Icon } from "../components/Icons.js";
import { ProtocolIcon } from "../components/ProtocolIcon.js";
import { EmptyState, StatusChip } from "../components/Ui.js";
import { humanAmount, severityTone } from "../lib/portfolio.js";
import { getYieldAllocation, type YieldAllocationPlanView } from "../api.js";

type ProtectWorkspace = "protect" | "earn";

interface ProtectPageProps {
  envelope: PositionEnvelope | null;
  risks: RiskFinding[];
  intent: TransactionIntent | null;
  planning: boolean;
  onPlan: (positionId: string, amountAtomic: string) => void;
  onInspect: () => void;
  walletConnected: boolean;
  submitting: boolean;
  submission: { state: string; txid: string } | null;
  onSign: (intent: TransactionIntent, positionId: string, amountAtomic: string) => void;
}

export function ProtectPage(props: ProtectPageProps) {
  const lendingPositions = useMemo(
    () =>
      props.envelope?.positions.filter(
        (position): position is LendingPosition => position.type === "lending",
      ) ?? [],
    [props.envelope],
  );
  const [selectedId, setSelectedId] = useState("");
  const selected =
    lendingPositions.find((position) => position.id === selectedId) ?? lendingPositions[0] ?? null;
  const [amount, setAmount] = useState("9500");
  const [target, setTarget] = useState<"policy" | "safer" | "custom">("safer");
  const [plannedAtomic, setPlannedAtomic] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<ProtectWorkspace>("protect");
  const atomicAmount = selected ? decimalToAtomic(amount, selected.debt.decimals) : "";
  const activeIntent = props.intent && plannedAtomic === atomicAmount ? props.intent : null;
  const risk = selected
    ? props.risks.find((finding) => finding.positionId === selected.id && finding.category === "liquidation")
    : undefined;

  if (workspace === "earn") {
    return (
      <main className="protect-dashboard">
        <ProtectHeading step={1} workspace={workspace} onWorkspaceChange={setWorkspace} />
        <YieldStrategySimulator />
      </main>
    );
  }

  if (!props.envelope) {
    return (
      <main className="protect-dashboard">
        <ProtectHeading step={1} workspace={workspace} onWorkspaceChange={setWorkspace} />
        <section className="protect-empty page-state-stage with-heading">
          <EmptyState
            title="No position evidence loaded"
            description="Inspect a Stacks address before preparing a protective action or comparing evidenced yield strategies."
            action={
              <button className="btn primary" onClick={props.onInspect}>
                Inspect address
              </button>
            }
          />
        </section>
      </main>
    );
  }

  if (!selected) {
    return (
      <main className="protect-dashboard">
        <ProtectHeading step={1} workspace={workspace} onWorkspaceChange={setWorkspace} />
        <section className="protect-empty page-state-stage with-heading">
          <EmptyState
            title="No lending position to protect"
            description="This address has no canonical debt position eligible for repayment. You can still compare yield opportunities supported by its current evidence."
            action={
              <button className="btn primary" onClick={() => setWorkspace("earn")}>
                Explore yield strategies
              </button>
            }
          />
        </section>
      </main>
    );
  }

  const walletAsset = findSpendableWalletForDebt(props.envelope.positions, selected.debt);
  const beforeHealth = evidence(risk, "healthFactor");
  const beforeLtv = evidence(risk, "ltv");
  const afterHealth = activeIntent?.simulation.postHealthFactor ?? null;
  const debtAfter = activeIntent ? subtractAtomic(selected.debt.amountAtomic, atomicAmount) : null;
  const afterLtv =
    activeIntent && beforeLtv && debtAfter
      ? proportionalLtv(beforeLtv, selected.debt.amountAtomic, debtAfter)
      : null;
  const expired = activeIntent ? Date.parse(activeIntent.expiresAt) <= Date.now() : false;
  const passed = activeIntent?.status === "ready" && activeIntent.simulation.status === "passed" && !expired;
  const isShadow = activeIntent?.executionMode === "shadow" || activeIntent?.network === "mainnet";
  const step = props.submission ? 3 : activeIntent ? 2 : 1;
  const riskTone = severityTone(risk?.severity);
  const requestedValid =
    atomicAmount !== "" &&
    BigInt(atomicAmount) > 0n &&
    BigInt(atomicAmount) <= BigInt(selected.debt.amountAtomic);

  function plan() {
    if (!selected || !requestedValid) return;
    setPlannedAtomic(atomicAmount);
    props.onPlan(selected.id, atomicAmount);
  }

  function chooseFraction(numerator: bigint, denominator: bigint) {
    const next = (BigInt(selected!.debt.amountAtomic) * numerator) / denominator;
    setAmount(humanAmount(next.toString(), selected!.debt.decimals, selected!.debt.decimals));
  }

  return (
    <main className="protect-dashboard">
      <ProtectHeading step={step} workspace={workspace} onWorkspaceChange={setWorkspace} />
      {isShadow ? (
        <section className="protect-mode-notice" role="status">
          <Icon name="info" size={16} />
          <span>
            <strong>Mainnet preview only.</strong> Preflight is advisory — broadcast stays disabled in shadow
            mode.
          </span>
        </section>
      ) : null}
      <div className="protect-workspace">
        <section className="protect-builder protect-card">
          <header>
            <h2>1. Choose repayment</h2>
            <p>Pick the debt position and how much to repay.</p>
          </header>
          <div className="protect-builder-body">
            <div className="protect-risk-summary">
              <div>
                <strong>
                  {protocolName(selected.protocol.id)} · {selected.debt.asset} debt
                </strong>
                <StatusChip tone={riskTone}>
                  {risk ? titleCase(risk.severity) : "Unscored"}
                </StatusChip>
              </div>
              <p>
                {risk?.meaning ??
                  `Repaying ${selected.debt.asset} lowers debt while collateral stays put.`}
              </p>
            </div>
            {lendingPositions.length > 1 ? (
              <label className="protect-field">
                <span>Position</span>
                <select
                  value={selected.id}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setPlannedAtomic(null);
                  }}
                >
                  {lendingPositions.map((position) => (
                    <option key={position.id} value={position.id}>
                      {protocolName(position.protocol.id)} ·{" "}
                      {humanAmount(position.debt.amountAtomic, position.debt.decimals)}{" "}
                      {position.debt.asset} debt
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="protect-field">
              <span>Amount to repay</span>
              <div className="protect-amount-row">
                <label>
                  <input
                    aria-label={`Amount in ${selected.debt.asset}`}
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setPlannedAtomic(null);
                    }}
                  />
                  <b>{selected.debt.asset}</b>
                </label>
                <button type="button" onClick={() => chooseFraction(1n, 4n)}>
                  25%
                </button>
                <button type="button" onClick={() => chooseFraction(1n, 2n)}>
                  50%
                </button>
                <button type="button" onClick={() => chooseFraction(1n, 1n)}>
                  Max
                </button>
              </div>
              <small>
                Debt balance{" "}
                {humanAmount(selected.debt.amountAtomic, selected.debt.decimals)} {selected.debt.asset}
                {walletAsset
                  ? ` · Wallet ${humanAmount(walletAsset.asset.amountAtomic, walletAsset.asset.decimals)} ${walletAsset.asset.asset}`
                  : ` · No free ${selected.debt.asset} in wallet to repay with`}
              </small>
            </div>
            <div className="protect-field">
              <span>Target health factor</span>
              <div className="protect-targets">
                <button
                  type="button"
                  className={target === "policy" ? "active" : ""}
                  onClick={() => setTarget("policy")}
                >
                  <i />
                  1.35
                </button>
                <button
                  type="button"
                  className={target === "safer" ? "active" : ""}
                  onClick={() => setTarget("safer")}
                >
                  <i />
                  1.50 safer
                </button>
                <button
                  type="button"
                  className={target === "custom" ? "active" : ""}
                  onClick={() => setTarget("custom")}
                >
                  <i />
                  Custom
                </button>
              </div>
            </div>
            {!requestedValid && atomicAmount ? (
              <p className="protect-inline-error">Amount must not exceed the debt balance.</p>
            ) : null}
            <div className="protect-builder-actions">
              <button className="btn primary" disabled={props.planning || !requestedValid} onClick={plan}>
                {props.planning ? "Running preflight…" : "Run preflight"}
                <Icon name="arrow" size={16} />
              </button>
              <button
                type="button"
                className="protect-reset"
                onClick={() => {
                  setAmount("9500");
                  setPlannedAtomic(null);
                }}
              >
                Reset
              </button>
            </div>
            <p className="protect-builder-note">
              Non-custodial: RiskOS builds an unsigned intent. Your wallet signs and broadcasts.
            </p>
          </div>
        </section>
        <SimulationPanel
          selected={selected}
          risk={risk}
          intent={activeIntent}
          amountAtomic={atomicAmount}
          beforeHealth={beforeHealth}
          beforeLtv={beforeLtv}
          afterHealth={afterHealth}
          afterLtv={afterLtv}
          debtAfter={debtAfter}
          passed={passed}
          expired={expired}
          isShadow={isShadow}
          walletConnected={props.walletConnected}
          submitting={props.submitting}
          submission={props.submission}
          onSign={() => activeIntent && props.onSign(activeIntent, selected.id, atomicAmount)}
        />
      </div>
    </main>
  );
}

function ProtectHeading({
  step,
  workspace,
  onWorkspaceChange,
}: {
  step: number;
  workspace: ProtectWorkspace;
  onWorkspaceChange: (workspace: ProtectWorkspace) => void;
}) {
  return (
    <>
      <header className="protect-heading">
        <div>
          <h1>{workspace === "protect" ? "Protect position" : "Explore yield strategies"}</h1>
          <p>
            {workspace === "protect"
              ? "Repay debt safely — preview first, sign only when ready."
              : "Compare evidenced lending and liquidity returns for hypothetical capital."}
          </p>
        </div>
        {workspace === "protect" ? (
          <div className="protect-steps" aria-label="Protection progress">
            {["Choose", "Preview", "Sign"].map((label, index) => {
              const activeStep = step >= 3 ? 3 : step >= 2 ? 2 : 1;
              return (
                <div key={label} className={activeStep >= index + 1 ? "active" : ""}>
                  <b>{index + 1}</b>
                  <span>{label}</span>
                  {index < 2 ? <i /> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </header>
      <nav className="protect-workspace-switch" aria-label="Protect workspace">
        <button
          type="button"
          className={workspace === "protect" ? "active" : ""}
          onClick={() => onWorkspaceChange("protect")}
        >
          <Icon name="shield" size={17} /> Protect a position
        </button>
        <button
          type="button"
          className={workspace === "earn" ? "active" : ""}
          onClick={() => onWorkspaceChange("earn")}
        >
          <Icon name="coins" size={17} /> Explore earning strategies
        </button>
      </nav>
    </>
  );
}

function YieldStrategySimulator() {
  const [capital, setCapital] = useState("1000000");
  const [days, setDays] = useState<30 | 90 | 365>(365);
  const [plan, setPlan] = useState<YieldAllocationPlanView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [retry, setRetry] = useState(0);
  const capitalValid = validYieldCapital(capital);

  useEffect(() => {
    if (!capitalValid) {
      setPlan(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailure("");
      void getYieldAllocation(capital, days, controller.signal)
        .then((result) => {
          setPlan(result);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setFailure(error instanceof Error ? error.message : "Strategy discovery failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [capital, days, capitalValid, retry]);

  const unavailable = loading ? [] : plan?.markets.filter((market) => !market.eligibleForAllocation) ?? [];
  const providerReportedCount = plan?.allocations.filter(
    (allocation) => allocation.evidenceState === "provider-reported",
  ).length ?? 0;
  return (
    <section className="yield-simulator">
      <div className="yield-integrity-notice">
        <Icon name="info" size={18} />
        <div>
          <strong>Explore allowlisted yield opportunities</strong>
          <span>
            RiskOS discovers signed-registry markets independently of this wallet and builds an evidence-labeled
            simulation split. Provider-reported rates stay labeled; this is not an executable allocation.
          </span>
        </div>
      </div>
      <section className="yield-controls protect-card" aria-busy={loading}>
        <div>
          <label htmlFor="yield-capital">Capital to test (USD equivalent)</label>
          <div className="yield-capital-input">
            <span>$</span>
            <input
              id="yield-capital"
              inputMode="decimal"
              value={capital}
              onChange={(event) => setCapital(event.target.value)}
              aria-invalid={!capitalValid}
              aria-describedby="yield-capital-help"
              maxLength={16}
            />
          </div>
          <small id="yield-capital-help">
            Enter $0.01–$1 trillion. This common USD basis excludes conversion, routing, and transaction costs.
          </small>
        </div>
        <div>
          <span>Simulation period</span>
          <div className="yield-horizon" role="group" aria-label="Yield simulation period">
            {([30, 90, 365] as const).map((option) => (
              <button
                key={option}
                className={days === option ? "active" : ""}
                onClick={() => setDays(option)}
              >
                {option === 365 ? "1 year" : `${option} days`}
              </button>
            ))}
          </div>
          <small>Uses each current annualized rate unchanged for the selected period.</small>
        </div>
      </section>
      <section className="yield-plan-summary protect-card">
        <header>
          <div>
            <h2>Simulated yield split</h2>
            <p>Evidence-labeled exploration across the signed-registry market universe.</p>
          </div>
          {loading ? (
            <span className="yield-refresh-state"><Icon name="refresh" size={14} /> Discovering markets</span>
          ) : (
            <StatusChip tone={plan?.allocations.length ? "healthy" : "uncertain"}>
              {plan?.allocations.length ?? 0} market{plan?.allocations.length === 1 ? "" : "s"} in simulation
            </StatusChip>
          )}
        </header>
        {loading ? (
          <YieldLoadingState refreshing={plan !== null} />
        ) : failure ? (
          <div className="yield-request-error" role="alert">
            <YieldMessage icon="info" title="Simulation unavailable" detail={failure} />
            <button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>Try again</button>
          </div>
        ) : plan?.allocations.length ? (
          <>
            <div className="yield-evidence-summary">
              <strong>Evidence used in this simulation</strong>
              <span>{plan.allocations.length - providerReportedCount} pinned on-chain rate{plan.allocations.length - providerReportedCount === 1 ? "" : "s"}</span>
              <span>{providerReportedCount} protocol-reported rate{providerReportedCount === 1 ? "" : "s"}</span>
              <span>
                Oldest evidence used {plan.evidenceAsOf ? new Date(plan.evidenceAsOf).toLocaleString() : "unavailable"}
              </span>
            </div>
            <div className="yield-plan-totals">
              <YieldTotal label="Capital allocated" value={money(plan.allocatedUsd)} />
              <YieldTotal label="Projected gross earnings" value={money(plan.projectedGrossEarningsUsd)} />
              <YieldTotal
                label="Allocated-capital headline rate"
                value={`${(plan.weightedAnnualizedRateBps / 100).toFixed(2)}%`}
              />
              <YieldTotal label="Held idle" value={money(plan.unallocatedUsd)} />
            </div>
            {providerReportedCount > 0 ? (
              <div className="yield-provider-warning" role="note">
                <Icon name="info" size={17} />
                <span>
                  Protocol-reported rates are labeled and can change quickly. Simulated amounts are capped at 2% of
                  reported TVL when that capacity is available.
                </span>
              </div>
            ) : null}
            <div className="yield-ranked-list">
              {plan.allocations.map((allocation, index) => (
                <article className="yield-allocation-row" key={allocation.marketId}>
                  <div className="yield-rank">#{index + 1}</div>
                  <ProtocolIcon protocol={allocation.protocol} size={38} />
                  <div>
                    <span>
                      {protocolName(allocation.protocol)} · {allocation.kind}
                    </span>
                    <strong>{allocation.assets}</strong>
                    <small>
                      {allocation.evidenceState === "verified"
                        ? "Pinned on-chain rate"
                        : "Protocol-reported current rate"}
                    </small>
                  </div>
                  <div>
                    <span>Allocate</span>
                    <strong>{money(allocation.amountUsd)}</strong>
                    <small>{(allocation.shareBps / 100).toFixed(1)}% of capital</small>
                  </div>
                  <div>
                    <span>Current {allocation.rateLabel}</span>
                    <strong>{(allocation.annualizedRateBps / 100).toFixed(2)}%</strong>
                    <small>
                      {Math.round(allocation.confidenceScore * 100)}% evidence confidence · observed{" "}
                      {new Date(allocation.observedAt).toLocaleTimeString()}
                    </small>
                  </div>
                  <div>
                    <span>Projected gross earnings</span>
                    <strong>{money(allocation.projectedGrossEarningsUsd)}</strong>
                    <small>Over {days === 365 ? "1 year" : `${days} days`}</small>
                  </div>
                  <div className="yield-allocation-evidence">
                    <span>Evidence & capacity</span>
                    <strong>
                      {allocation.observedAtBlock === null
                        ? "Provider observation"
                        : `Stacks block ${allocation.observedAtBlock.toLocaleString()}`}
                    </strong>
                    <small>
                      {allocation.reportedTvlCapacityUsd === null
                        ? "No reported-TVL capacity bound available"
                        : `${money(allocation.reportedTvlCapacityUsd)} maximum at 2% of reported TVL`}
                    </small>
                    {allocation.independentRateEvidence ? (
                      <small>
                        Independent comparison: {(allocation.independentRateEvidence.annualizedRateBps / 100).toFixed(2)}%
                        {" · "}{allocation.independentRateEvidence.differenceBps} bps from the pinned rate
                        {" · as of "}{new Date(allocation.independentRateEvidence.observedAt).toLocaleTimeString()}
                      </small>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
            <p className="yield-policy-copy">
              {plan.policy.objective} Maximum per protocol:{" "}
              {(plan.policy.maximumProtocolShareBps / 100).toFixed(0)}%; maximum per market:{" "}
              {(plan.policy.maximumMarketShareBps / 100).toFixed(0)}%; markets with reported TVL: at most{" "}
              {(plan.policy.maximumPoolTvlShareBps / 100).toFixed(0)}% of reported TVL.
            </p>
          </>
        ) : (
          <YieldMessage
            icon="shield"
            title={
              capitalValid
                ? "No market currently has a usable rate for simulation"
                : "Enter a valid capital amount"
            }
            detail={
              capitalValid
                ? "Idle 0% vaults and uncovered protocols stay listed below. Capital stays idle until at least one market reports a positive current rate."
                : "Use an amount from $0.01 through $1 trillion, with no more than two decimal places."
            }
          />
        )}
      </section>
      {unavailable.length ? (
        <section className="yield-unranked protect-card">
          <header>
            <div>
              <h2>Held out by hard constraints</h2>
              <p>
                These markets stay in the universe for exploration, but receive no simulated capital while the
                current rate is exactly 0% or no usable rate exists yet. Concentration and TVL caps still apply to
                markets already in the split above.
              </p>
            </div>
            <StatusChip tone="uncertain">{unavailable.length} held out</StatusChip>
          </header>
          <div className="yield-unallocated-grid">
            {unavailable.map((market) => {
              const constraint = hardConstraintKind(market);
              return (
                <article key={market.id} className={`yield-held-out ${constraint}`}>
                  <ProtocolIcon protocol={market.protocol} size={32} />
                  <div className="yield-unallocated-name">
                    <strong>
                      {protocolName(market.protocol)} · {market.assets}
                    </strong>
                    <span>
                      {market.kind} · {evidenceLabel(market.evidenceState)}
                    </span>
                  </div>
                  <div className="yield-held-out-metrics">
                    <div>
                      <span>Current {market.rateLabel}</span>
                      <strong>
                        {market.annualizedRateBps === null
                          ? "Unavailable"
                          : `${(market.annualizedRateBps / 100).toFixed(2)}%`}
                      </strong>
                    </div>
                    <div>
                      <span>Constraint</span>
                      <strong>{constraint === "idle" ? "Idle · 0% rate" : "No usable rate"}</strong>
                    </div>
                  </div>
                  <div className={`yield-unallocated-reason ${constraint}`}>
                    <b>{unallocatedReason(market)}</b>
                    <small>{unallocatedExplanation(market)}</small>
                  </div>
                  <details>
                    <summary>Evidence details</summary>
                    <p>{market.meaning}</p>
                    <span>
                      {market.observedAtBlock
                        ? `Stacks block ${market.observedAtBlock.toLocaleString()}`
                        : "No pinned block observation"}
                    </span>
                  </details>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      <footer className="yield-methodology">
        <strong>What this exploration does—and does not mean</strong>
        <p>
          APR projections use allocated capital × APR × days ÷ 365; Reward APY projections use the equivalent
          compounded return for the selected period. The split is optimized automatically under the displayed
          concentration and liquidity constraints. Network fees,
          swaps, LP range changes, impermanent loss, incentives, taxes, and protocol entry or exit fees are
          excluded unless independently quoted; these are gross comparisons, not promised profit.
        </p>
      </footer>
    </section>
  );
}

function YieldLoadingState({ refreshing }: { refreshing: boolean }) {
  return (
    <div className="yield-loading-state" role="status" aria-live="polite">
      <div className="yield-loading-spinner"><Icon name="refresh" size={24} /></div>
      <strong>{refreshing ? "Refreshing the simulation…" : "Building an evidence-labeled simulation…"}</strong>
      <span>Checking signed contracts, current rates, reported capacity, and evidence freshness.</span>
      <div className="yield-loading-steps" aria-hidden="true">
        <i /><i /><i />
      </div>
    </div>
  );
}

function hardConstraintKind(market: YieldAllocationPlanView["markets"][number]): "idle" | "unavailable" {
  return market.annualizedRateBps === 0 ? "idle" : "unavailable";
}

function evidenceLabel(state: YieldAllocationPlanView["markets"][number]["evidenceState"]) {
  if (state === "verified") return "on-chain evidence";
  if (state === "provider-reported") return "protocol-reported evidence";
  return "rate evidence unavailable";
}

function unallocatedReason(market: YieldAllocationPlanView["markets"][number]) {
  if (market.annualizedRateBps === 0) return "Hard constraint · current organic rate is 0%";
  if (market.annualizedRateBps === null) return "Hard constraint · no usable current rate";
  return market.allocationExclusionReason ?? "Hard constraint · market excluded from this split";
}

function unallocatedExplanation(market: YieldAllocationPlanView["markets"][number]) {
  if (market.annualizedRateBps === 0) {
    return `Pinned utilization currently reconstructs a 0.00% ${market.rateLabel}. The market stays visible, but explore will not simulate capital into a zero rate. Separate incentives stay excluded until they have explicit current evidence.`;
  }
  if (market.evidenceState === "unavailable" || market.annualizedRateBps === null) {
    return "No current annualized rate passed protocol evidence checks, so this market cannot enter the simulated split yet.";
  }
  return (
    market.allocationExclusionReason ??
    "This market failed a hard explore gate and cannot receive simulated capital."
  );
}

function validYieldCapital(value: string): boolean {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return cents > 0n && cents <= 100_000_000_000_000n;
}

function YieldMessage({
  icon,
  title,
  detail,
}: {
  icon: "refresh" | "info" | "shield";
  title: string;
  detail: string;
}) {
  return (
    <div className="yield-ranking-empty">
      <Icon name={icon} size={26} />
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function YieldTotal({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function money(value: string) {
  return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface SimulationProps {
  selected: LendingPosition;
  risk: RiskFinding | undefined;
  intent: TransactionIntent | null;
  amountAtomic: string;
  beforeHealth: string | null;
  beforeLtv: string | null;
  afterHealth: string | null;
  afterLtv: string | null;
  debtAfter: string | null;
  passed: boolean;
  expired: boolean;
  isShadow: boolean;
  walletConnected: boolean;
  submitting: boolean;
  submission: { state: string; txid: string } | null;
  onSign: () => void;
}

function SimulationPanel(props: SimulationProps) {
  const pending = !props.intent;
  const call = props.intent?.calls[0];
  const beforeDebt = humanAmount(props.selected.debt.amountAtomic, props.selected.debt.decimals);
  const repayment = repaymentBreakdown(
    props.selected.debt.amountAtomic,
    props.amountAtomic,
    props.selected.debt.decimals,
  );
  const afterDebt = props.intent ? repayment.remaining : null;
  const feeCap = props.intent
    ? `${humanAmount(String(props.intent.guardrails.maximumFeeMicroStx), 6)} STX`
    : null;
  const freshness = props.intent ? !props.expired : false;
  const amountWithinDebt =
    props.amountAtomic !== "" && BigInt(props.amountAtomic) <= BigInt(props.selected.debt.amountAtomic);

  if (pending || !props.intent) {
    return (
      <section className="protect-simulation protect-card protect-simulation-idle">
        <header className="protect-simulation-head">
          <div>
            <h2>2. Preview outcome</h2>
            <p>Current position first — projected values appear after preflight.</p>
          </div>
        </header>
        <div className="protect-idle-current">
          <h3>Current position</h3>
          <div className="protect-idle-metrics">
            <Datum label="Health factor" value={props.beforeHealth ?? "Unavailable"} />
            <Datum label="LTV" value={formatPercent(props.beforeLtv)} />
            <Datum label="Debt" value={beforeDebt} suffix={props.selected.debt.asset} />
          </div>
        </div>
        <div className="protect-idle-prompt">
          <Icon name="shield" size={28} />
          <strong>Ready when you are</strong>
          <p>
            Set an amount on the left and run preflight. RiskOS will show debt paid, health-factor change, and
            policy checks — nothing is signed until you choose to continue.
          </p>
        </div>
      </section>
    );
  }

  const intent = props.intent;

  return (
    <section className="protect-simulation protect-card">
      <header className="protect-simulation-head">
        <div>
          <h2>2. Preview outcome</h2>
          <p>Deterministic preview from verified inputs — no transaction has executed.</p>
        </div>
        <StatusChip tone={props.passed ? "healthy" : "critical"}>
          {props.passed ? "Preflight passed" : "Preflight blocked"}
        </StatusChip>
      </header>

      <div className="protect-before-after">
        <article className="protect-state-card">
          <header>
            <h3>Before</h3>
            <StatusChip tone={severityTone(props.risk?.severity)}>
              {props.risk ? titleCase(props.risk.severity) : "Unscored"}
            </StatusChip>
          </header>
          <div className="protect-before-grid">
            <Datum label="Health factor" value={props.beforeHealth ?? "Unavailable"} />
            <Datum label="LTV" value={formatPercent(props.beforeLtv)} />
            <Datum label="Debt" value={beforeDebt} suffix={props.selected.debt.asset} />
          </div>
        </article>
        <span className="protect-transition" aria-hidden="true">
          <Icon name="arrow" size={24} />
        </span>
        <article className="protect-state-card protect-state-after">
          <header>
            <h3>After</h3>
            <StatusChip tone={props.passed ? "healthy" : "critical"}>
              {projectedRisk(props.afterHealth)}
            </StatusChip>
          </header>
          <div className="protect-before-grid">
            <Datum label="Health factor" value={props.afterHealth ?? "—"} />
            <Datum label="LTV" value={props.afterLtv ? formatPercent(props.afterLtv) : "—"} />
            <Datum
              label="Debt"
              value={afterDebt ?? "—"}
              suffix={afterDebt ? props.selected.debt.asset : undefined}
            />
          </div>
        </article>
      </div>

      <section className={`protect-settlement ${props.passed ? "ready" : "blocked"}`}>
        <header>
          <h3>Repayment</h3>
          <p>
            You pay {repayment.applied} {props.selected.debt.asset} · {repayment.percent}% of debt
            {repayment.isFull ? " (full repay)" : ""}
          </p>
        </header>
        <div className="protect-settlement-flow compact">
          <SettlementDatum
            eyebrow="You pay"
            value={repayment.applied}
            suffix={props.selected.debt.asset}
            detail="From wallet to lending contract"
          />
          <span className="protect-settlement-arrow" aria-hidden="true">
            <Icon name="arrow" size={18} />
          </span>
          <SettlementDatum
            eyebrow="Debt left"
            value={repayment.remaining}
            suffix={props.selected.debt.asset}
            detail={repayment.isFull ? "Fully repaid" : "Remaining principal"}
            accent
          />
        </div>
        <div className="protect-fee-summary compact">
          <div>
            <span>Network fee cap</span>
            <strong>{feeCap ?? "—"}</strong>
          </div>
          <div>
            <span>Protocol fee</span>
            <strong>Not quoted</strong>
          </div>
          <div>
            <span>Health change</span>
            <strong>{healthChange(props.beforeHealth, props.afterHealth)}</strong>
          </div>
        </div>
      </section>

      <div className="protect-result-grid">
        <article className="protect-subcard protect-trajectory">
          <h3>Health factor</h3>
          <div className="protect-trajectory-chart">
            <div className="policy-line">
              <span>1.35</span>
            </div>
            <Point label="Now" value={props.beforeHealth} tone="current" />
            <Point label="After" value={props.afterHealth} tone="after" />
          </div>
        </article>
        <article className="protect-subcard protect-checks">
          <h3>Policy checks</h3>
          <CheckRow label="Contract allowlisted" value={call ? "Matched" : "Missing"} good={Boolean(call)} />
          <CheckRow
            label="Evidence fresh"
            value={freshness ? "Within expiry" : "Expired"}
            good={freshness}
          />
          <CheckRow
            label="Amount within debt"
            value={amountWithinDebt ? "Within limit" : "Review"}
            good={amountWithinDebt}
          />
          <CheckRow label="Wallet signature" value="Required" good />
        </article>
      </div>

      <details className="protect-more-details">
        <summary>Execution path & provenance</summary>
        <div className="protect-evidence-grid">
          <article className="protect-subcard protect-path">
            <h3>Transaction path</h3>
            <div>
              <PathNode icon="wallet" label="Your wallet" detail={props.selected.debt.asset} />
              <Icon name="arrow" size={17} />
              <PathNode icon="reports" label="Allowlisted contract" detail="Repay debt" />
              <Icon name="arrow" size={17} />
              <PathNode icon="coins" label="Debt reduced" detail={props.selected.debt.asset} />
            </div>
          </article>
          <article className="protect-subcard protect-provenance">
            <h3>Data provenance</h3>
            <dl>
              <dt>Risk model</dt>
              <dd>{props.risk ? `${props.risk.model.id}@${props.risk.model.version}` : "Unavailable"}</dd>
              <dt>Confidence</dt>
              <dd>{props.risk ? `${Math.round(props.risk.confidence.score * 100)}%` : "Unavailable"}</dd>
              <dt>State block</dt>
              <dd>
                {intent.simulation.stateBlock ??
                  props.selected.provenance[0]?.blockHeight ??
                  "Unavailable"}
              </dd>
              <dt>Intent expires</dt>
              <dd>{formatDate(intent.expiresAt)}</dd>
            </dl>
          </article>
        </div>
      </details>

      <IntentStatus intent={intent} passed={props.passed} isShadow={props.isShadow} />

      {props.submission ? (
        <section className="protect-submission">
          <Icon name="check" size={19} />
          <div>
            <strong>Transaction confirmed</strong>
            <span className="mono">{props.submission.txid}</span>
          </div>
        </section>
      ) : props.passed ? (
        <section className="protect-sign">
          <div>
            <strong>{props.isShadow ? "Preview complete" : "3. Sign when ready"}</strong>
            <span>
              {intent.network} · expires {formatDate(intent.expiresAt)}
            </span>
          </div>
          {props.isShadow ? (
            <button type="button" className="btn secondary" disabled>
              Broadcast disabled in shadow mode
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={props.submitting} onClick={props.onSign}>
              {props.submitting
                ? "Preparing wallet…"
                : props.walletConnected
                  ? "Review and sign in wallet"
                  : "Connect wallet and continue"}
            </button>
          )}
        </section>
      ) : null}
    </section>
  );
}

function SettlementDatum({
  eyebrow,
  value,
  suffix,
  detail,
  accent = false,
}: {
  eyebrow: string;
  value: string;
  suffix?: string | undefined;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className={`protect-settlement-datum ${accent ? "accent" : ""}`}>
      <span>{eyebrow}</span>
      <strong>{value}</strong>
      {suffix ? <b>{suffix}</b> : null}
      <small>{detail}</small>
    </div>
  );
}

function Datum({
  label,
  value,
  suffix,
  pending = false,
}: {
  label: string;
  value: string;
  suffix?: string | undefined;
  pending?: boolean;
}) {
  return (
    <div className={pending ? "pending" : ""}>
      <span>{label}</span>
      <strong>{value}</strong>
      {suffix ? <small>{suffix}</small> : null}
    </div>
  );
}
function CheckRow({
  label,
  value,
  good = false,
  neutral = false,
}: {
  label: string;
  value: string;
  good?: boolean;
  neutral?: boolean;
}) {
  return (
    <div>
      <i className={good ? "good" : neutral ? "neutral" : "pending"}>{good ? "✓" : neutral ? "−" : "·"}</i>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function PathNode({
  icon,
  label,
  detail,
}: {
  icon: "wallet" | "reports" | "coins";
  label: string;
  detail: string;
}) {
  return (
    <div>
      <i>
        <Icon name={icon} size={19} />
      </i>
      <strong>{label}</strong>
      <span>{detail}</span>
    </div>
  );
}
function Point({ label, value, tone }: { label: string; value: string | null; tone: string }) {
  const number = Number(value);
  const bottom = Number.isFinite(number) ? Math.max(5, Math.min(88, (number / 2) * 100)) : 10;
  return (
    <div className={`trajectory-point ${tone}`} style={{ bottom: `${bottom}%` }}>
      <b>{value ?? "?"}</b>
      <i />
      <span>{label}</span>
    </div>
  );
}
function IntentStatus({
  intent,
  passed,
  isShadow,
}: {
  intent: TransactionIntent;
  passed: boolean;
  isShadow: boolean;
}) {
  return (
    <section className={`protect-intent-status ${passed ? "passed" : "blocked"}`}>
      <div>
        <Icon name={passed ? "check" : "info"} size={18} />
        <span>
          <h3>{passed ? "Preflight passed" : "Preflight blocked"}</h3>
          <small>
            {isShadow
              ? "Preview only · mainnet shadow controls remain active"
              : `${intent.network} execution is available only before expiry`}
          </small>
        </span>
      </div>
      {intent.warnings.length ? (
        <ul>
          {intent.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function evidence(risk: RiskFinding | undefined, metric: string) {
  return risk?.evidence.find((item) => item.metric === metric)?.value ?? null;
}
function protocolName(value: string) {
  return value.toLowerCase().includes("zest") ? "Zest" : titleCase(value);
}
function titleCase(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatPercent(value: string | null) {
  if (!value || !Number.isFinite(Number(value))) return "Unavailable";
  return `${(Number(value) * 100).toFixed(1)}%`;
}
function projectedRisk(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  if (parsed <= 1) return "Critical";
  if (parsed < 1.35) return "Guarded";
  return "Improved";
}
function healthChange(before: string | null, after: string | null) {
  if (!before || !after) return "Unavailable";
  const delta = Number(after) - Number(before);
  return Number.isFinite(delta) ? `Health factor ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}` : "Unavailable";
}
function subtractAtomic(total: string, amount: string) {
  if (!/^\d+$/.test(amount)) return null;
  const result = BigInt(total) - BigInt(amount);
  return (result > 0n ? result : 0n).toString();
}

export function findSpendableWalletForDebt(
  positions: Position[],
  debt: { asset: string; assetIdentifier?: string | undefined; contractPrincipal?: string | undefined },
) {
  const debtKeys = new Set(
    [tokenKey(debt.asset), debt.assetIdentifier ? tokenKey(debt.assetIdentifier) : ""]
      .filter(Boolean)
      .map((key) => key.toLowerCase()),
  );
  const debtIdentifier = debt.assetIdentifier?.toLowerCase() ?? "";
  const debtContract = debt.contractPrincipal?.toLowerCase() ?? "";

  const matches = positions.filter((position) => {
    if (position.type !== "wallet") return false;
    // Native STX debt can only be repaid from spendable STX; PoX-locked STX is not usable.
    if (tokenKey(debt.asset) === "stx" && !position.spendable) return false;
    const symbol = tokenKey(position.asset.asset).toLowerCase();
    const identifier = (position.asset.assetIdentifier ?? "").toLowerCase();
    const id = position.id.toLowerCase();
    if (debtKeys.has(symbol)) return true;
    if (identifier && debtKeys.has(tokenKey(identifier).toLowerCase())) return true;
    if (debtIdentifier && (identifier === debtIdentifier || id.includes(debtIdentifier))) return true;
    if (debtContract && (identifier.startsWith(`${debtContract}::`) || id.includes(debtContract))) return true;
    return false;
  });

  const spendable = matches.find((position) => position.type === "wallet" && position.spendable);
  return spendable?.type === "wallet" ? spendable : matches[0]?.type === "wallet" ? matches[0] : null;
}

function tokenKey(value: string) {
  const token = value.includes("::") ? value.split("::").at(-1) : value;
  return (token ?? value).trim();
}

export function repaymentBreakdown(totalAtomic: string, requestedAtomic: string, decimals: number) {
  const total = /^\d+$/.test(totalAtomic) ? BigInt(totalAtomic) : 0n;
  const requested = /^\d+$/.test(requestedAtomic) ? BigInt(requestedAtomic) : 0n;
  const applied = requested > total ? total : requested;
  const remaining = total - applied;
  const percentageTenths = total === 0n ? 0n : (applied * 1_000n) / total;
  const percent = `${percentageTenths / 10n}.${percentageTenths % 10n}`;
  return {
    applied: humanAmount(applied.toString(), decimals, decimals),
    remaining: humanAmount(remaining.toString(), decimals, decimals),
    percent,
    isFull: total > 0n && remaining === 0n,
  };
}
function proportionalLtv(before: string, total: string, remaining: string) {
  if (BigInt(total) === 0n) return null;
  const ratio = Number((BigInt(remaining) * 1_000_000n) / BigInt(total)) / 1_000_000;
  return String(Number(before) * ratio);
}
function decimalToAtomic(value: string, decimals: number) {
  const match = value.trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) return "";
  const fraction = (match[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(`${match[1]}${fraction}` || "0").toString();
  } catch {
    return "";
  }
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}
