import { useMemo, useState } from "react";
import type {
  LendingPosition,
  PositionEnvelope,
  RiskFinding,
  TransactionIntent,
} from "../../../../packages/domain/src/index.js";
import { Icon } from "../components/Icons.js";
import { EmptyState, StatusChip } from "../components/Ui.js";
import { humanAmount, severityTone, shortAddress } from "../lib/portfolio.js";

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
  const atomicAmount = selected ? decimalToAtomic(amount, selected.debt.decimals) : "";
  const activeIntent = props.intent && plannedAtomic === atomicAmount ? props.intent : null;
  const risk = selected
    ? props.risks.find((finding) => finding.positionId === selected.id && finding.category === "liquidation")
    : undefined;

  if (!props.envelope || !selected) {
    return (
      <main className="protect-dashboard">
        <ProtectHeading step={1} />
        <section className="protect-empty page-state-stage with-heading">
          <EmptyState
            title={props.envelope ? "No lending position to protect" : "No position evidence loaded"}
            description={
              props.envelope
                ? "This address has no canonical debt position eligible for a repayment preview."
                : "Inspect a Stacks address before preparing a protective action."
            }
            action={
              !props.envelope ? (
                <button className="btn primary" onClick={props.onInspect}>
                  Inspect address
                </button>
              ) : undefined
            }
          />
        </section>
      </main>
    );
  }

  const walletMatch = props.envelope.positions.find(
    (position) =>
      position.type === "wallet" && position.asset.asset.toLowerCase() === selected.debt.asset.toLowerCase(),
  );
  const walletAsset = walletMatch?.type === "wallet" ? walletMatch : null;
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
  const step = props.submission ? 4 : activeIntent ? (passed && !isShadow ? 3 : 2) : 1;
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
      <ProtectHeading step={step} />
      <section className="protect-custody">
        <Icon name="shield" size={19} />
        <strong>Non-custodial</strong>
        <span>·</span>
        <span>RiskOS prepares an unsigned, allowlisted intent. Your wallet signs and broadcasts.</span>
      </section>
      {isShadow ? (
        <section className="protect-mode-notice">
          <strong>Mainnet preview protection</strong>
          <span>
            This simulation is advisory. Mainnet broadcast remains disabled while the execution release is in
            shadow mode.
          </span>
        </section>
      ) : null}
      <div className="protect-workspace">
        <section className="protect-builder protect-card">
          <header>
            <h2>
              Action builder <Icon name="info" size={14} />
            </h2>
          </header>
          <div className="protect-builder-body">
            <div className="protect-risk-summary">
              <div>
                <strong>Risk being addressed</strong>
                <StatusChip tone={riskTone}>
                  {risk ? titleCase(risk.severity) : "Evidence unavailable"}
                </StatusChip>
              </div>
              <p>
                {risk?.meaning ??
                  `Repaying ${selected.debt.asset} reduces debt while leaving collateral unchanged.`}
              </p>
            </div>
            <label className="protect-field">
              <span>
                Position <Icon name="info" size={12} />
              </span>
              <select
                value={selected.id}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setPlannedAtomic(null);
                }}
              >
                <option value={selected.id}>
                  {protocolName(selected.protocol.id)} ·{" "}
                  {humanAmount(selected.debt.amountAtomic, selected.debt.decimals)} {selected.debt.asset} debt
                </option>
                {lendingPositions
                  .filter((position) => position.id !== selected.id)
                  .map((position) => (
                    <option key={position.id} value={position.id}>
                      {protocolName(position.protocol.id)} ·{" "}
                      {humanAmount(position.debt.amountAtomic, position.debt.decimals)} {position.debt.asset}{" "}
                      debt
                    </option>
                  ))}
              </select>
            </label>
            <label className="protect-field">
              <span>
                Action <Icon name="info" size={12} />
              </span>
              <select disabled>
                <option>Repay debt</option>
              </select>
            </label>
            <div className="protect-field">
              <span>
                Amount ({selected.debt.asset}) <Icon name="info" size={12} />
              </span>
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
                <button onClick={() => chooseFraction(1n, 4n)}>25%</button>
                <button onClick={() => chooseFraction(1n, 2n)}>50%</button>
                <button onClick={() => chooseFraction(1n, 1n)}>Max</button>
              </div>
              <small>{atomicAmount ? `${atomicAmount} atomic units` : "Enter a valid decimal amount"}</small>
            </div>
            <div className="protect-field">
              <span>
                Target health factor <Icon name="info" size={12} />
              </span>
              <div className="protect-targets">
                <button className={target === "policy" ? "active" : ""} onClick={() => setTarget("policy")}>
                  <i />
                  Maintain 1.35
                </button>
                <button className={target === "safer" ? "active" : ""} onClick={() => setTarget("safer")}>
                  <i />
                  Safer 1.50
                </button>
                <button className={target === "custom" ? "active" : ""} onClick={() => setTarget("custom")}>
                  <i />
                  Custom
                </button>
              </div>
            </div>
            <div className="protect-field">
              <span>
                Pay from <Icon name="info" size={12} />
              </span>
              <div className="protect-wallet-row">
                <Icon name="wallet" size={17} />
                <span>Wallet ({shortAddress(props.envelope.address)})</span>
                <strong>
                  {walletAsset
                    ? `${humanAmount(walletAsset.asset.amountAtomic, walletAsset.asset.decimals)} ${walletAsset.asset.asset}`
                    : "Balance unavailable"}
                </strong>
              </div>
            </div>
            <div className="protect-approval">
              <span>
                <i className={passed ? "ok" : "pending"}>{passed ? "✓" : "i"}</i>
                {passed
                  ? `${selected.debt.asset} constraints verified`
                  : "Token constraints evaluated during simulation"}
              </span>
              <small>Intent post-conditions</small>
            </div>
            {!requestedValid && atomicAmount ? (
              <p className="protect-inline-error">Amount must not exceed the canonical debt balance.</p>
            ) : null}
            <div className="protect-builder-actions">
              <button className="btn primary" disabled={props.planning || !requestedValid} onClick={plan}>
                {props.planning ? "Simulating…" : "Simulate repayment"}
                <Icon name="arrow" size={16} />
              </button>
              <button
                className="protect-reset"
                onClick={() => {
                  setAmount("9500");
                  setPlannedAtomic(null);
                }}
              >
                Reset
              </button>
            </div>
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

function ProtectHeading({ step }: { step: number }) {
  return (
    <header className="protect-heading">
      <div>
        <h1>Protect position</h1>
        <p>Prepare, verify and simulate a protective action before signing.</p>
      </div>
      <div className="protect-steps" aria-label="Protection progress">
        {["Choose", "Simulate", "Review", "Sign"].map((label, index) => (
          <div key={label} className={step >= index + 1 ? "active" : ""}>
            <b>{index + 1}</b>
            <span>{label}</span>
            {index < 3 ? <i /> : null}
          </div>
        ))}
      </div>
    </header>
  );
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
  return (
    <section className="protect-simulation protect-card">
      <header className="protect-simulation-head">
        <h2>
          Before &amp; after (simulation preview) <Icon name="info" size={14} />
        </h2>
        <span>Values on the right are calculated by the simulation</span>
      </header>
      <div className="protect-before-after">
        <article className="protect-state-card">
          <header>
            <h3>Before (current)</h3>
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
        <span className="protect-transition">
          <Icon name="arrow" size={27} />
        </span>
        <article className="protect-state-card">
          <header>
            <h3>After (projected)</h3>
            <span className={`protect-pending ${props.passed ? "ready" : ""}`}>
              {pending ? "Pending simulation" : props.passed ? "Simulation passed" : "Simulation blocked"}
            </span>
          </header>
          <div className="protect-after-list">
            <Datum label="Health factor" value={props.afterHealth ?? "—"} pending={pending} />
            <Datum
              label="LTV"
              value={props.afterLtv ? formatPercent(props.afterLtv) : "—"}
              pending={pending}
            />
            <Datum
              label="Debt"
              value={afterDebt ?? "—"}
              suffix={afterDebt ? props.selected.debt.asset : undefined}
              pending={pending}
            />
            <Datum label="Risk state" value={projectedRisk(props.afterHealth)} pending={pending} />
          </div>
        </article>
      </div>
      <section className={`protect-settlement ${pending ? "pending" : "ready"}`}>
        <header>
          <div>
            <h3>Repayment summary</h3>
            <p>
              {pending
                ? "Run the simulation to verify the repayment outcome and execution limits."
                : "What leaves your wallet and how the debt position changes."}
            </p>
          </div>
          <StatusChip tone={props.passed ? "healthy" : pending ? "uncertain" : "critical"}>
            {pending ? "Awaiting simulation" : props.passed ? "Verified preview" : "Blocked preview"}
          </StatusChip>
        </header>
        <div className="protect-settlement-flow">
          <SettlementDatum
            eyebrow={props.passed ? "You pay" : pending ? "You pay" : "Requested payment"}
            value={pending ? "—" : repayment.applied}
            suffix={pending ? undefined : props.selected.debt.asset}
            detail={
              props.passed
                ? "Sent from your wallet to the lending contract"
                : pending
                  ? "Verified after simulation"
                  : "Not executable until every policy check passes"
            }
          />
          <span className="protect-settlement-arrow" aria-hidden="true">
            <Icon name="arrow" size={22} />
          </span>
          <SettlementDatum
            eyebrow={props.passed ? "Debt paid off" : "Requested debt reduction"}
            value={pending ? "—" : repayment.applied}
            suffix={pending ? undefined : props.selected.debt.asset}
            detail={pending ? "Calculated after simulation" : `${repayment.percent}% of current debt`}
            accent
          />
          <span className="protect-settlement-arrow" aria-hidden="true">
            <Icon name="arrow" size={22} />
          </span>
          <SettlementDatum
            eyebrow="Debt left"
            value={pending ? "—" : repayment.remaining}
            suffix={pending ? undefined : props.selected.debt.asset}
            detail={
              pending
                ? "Calculated after simulation"
                : repayment.isFull
                  ? "Position debt fully repaid"
                  : "Principal remaining after repayment"
            }
          />
        </div>
        <div className="protect-fee-summary">
          <div>
            <span>Protocol fee</span>
            <strong>Not quoted</strong>
            <small>The simulation does not return a separate Zest repayment fee.</small>
          </div>
          <div>
            <span>Network fee limit</span>
            <strong>{feeCap ?? "Pending simulation"}</strong>
            <small>
              This is a safety cap, not the final fee. The wallet shows the actual fee before signing.
            </small>
          </div>
          <div>
            <span>What you receive</span>
            <strong>
              {pending
                ? "Pending simulation"
                : props.passed
                  ? `${repayment.applied} ${props.selected.debt.asset} debt relief`
                  : "No executable outcome"}
            </strong>
            <small>Repayment reduces debt; it does not send a token payout to your wallet.</small>
          </div>
        </div>
      </section>
      <div className="protect-analysis-grid">
        <article className="protect-subcard protect-trajectory">
          <h3>Health factor trajectory</h3>
          <div className="protect-trajectory-legend">
            <span>
              <i className="current" />
              Current ({props.beforeHealth ?? "n/a"})
            </span>
            <span>
              <i className="after" />
              Projected ({props.afterHealth ?? "pending"})
            </span>
            <span>
              <i className="policy" />
              Policy target (1.35)
            </span>
          </div>
          <div className="protect-trajectory-chart">
            <div className="policy-line">
              <span>1.35</span>
            </div>
            <Point label="Current" value={props.beforeHealth} tone="current" />
            <Point label="After simulation" value={props.afterHealth} tone="after" />
          </div>
        </article>
        <article className="protect-subcard protect-changes">
          <h3>
            What changes (after simulation) <Icon name="info" size={12} />
          </h3>
          {[
            [
              "↓",
              "Debt decreases",
              pending
                ? "Calculated after simulation"
                : `${beforeDebt} → ${afterDebt} ${props.selected.debt.asset}`,
            ],
            [
              "↑",
              "Liquidation buffer",
              pending ? "Calculated after simulation" : healthChange(props.beforeHealth, props.afterHealth),
            ],
            [
              "↓",
              "Borrow interest",
              pending ? "Calculated after simulation" : "Lower principal accrues interest",
            ],
          ].map(([icon, label, value]) => (
            <div key={label}>
              <i>{icon}</i>
              <strong>{label}</strong>
              <span>{value}</span>
            </div>
          ))}
        </article>
        <article className="protect-subcard protect-execution">
          <h3>
            Estimated execution <Icon name="info" size={12} />
          </h3>
          <ExecutionRow
            icon="bridge"
            label="Route"
            value={
              call ? `${protocolName(props.selected.protocol.id)} ${call.function}` : "Pending simulation"
            }
          />
          <ExecutionRow
            icon="reports"
            label="Contract"
            value={call ? "Allowlisted by registry" : "Pending simulation"}
            good={Boolean(call)}
          />
          <ExecutionRow
            icon="info"
            label="Evidence"
            value={props.intent ? (freshness ? "Fresh at simulation" : "Expired") : "Pending simulation"}
            good={freshness}
          />
          <ExecutionRow
            icon="reports"
            label="Transactions"
            value={
              props.intent
                ? `${props.intent.calls.length} Stacks transaction${props.intent.calls.length === 1 ? "" : "s"}`
                : "Pending simulation"
            }
          />
          <ExecutionRow
            icon="coins"
            label="Network fee cap"
            value={feeCap ?? "Calculated after simulation"}
          />
        </article>
      </div>
      {props.intent ? (
        <IntentStatus intent={props.intent} passed={props.passed} isShadow={props.isShadow} />
      ) : (
        <div className="protect-prompt">
          <Icon name="info" size={16} />
          <span>
            Choose an amount and run the simulation to calculate exact after-values, policy checks, fees and
            transaction details.
          </span>
        </div>
      )}
      <div className="protect-evidence-grid">
        <article className="protect-subcard protect-path">
          <h3>
            Transaction path <Icon name="info" size={12} />
          </h3>
          <div>
            <PathNode icon="wallet" label="Your wallet" detail={props.selected.debt.asset} />
            <Icon name="arrow" size={17} />
            <PathNode icon="reports" label="Allowlisted contract" detail="Repay debt" />
            <Icon name="arrow" size={17} />
            <PathNode icon="coins" label="Debt reduced" detail={props.selected.debt.asset} />
          </div>
        </article>
        <article className="protect-subcard protect-checks">
          <h3>
            Policy checks <Icon name="info" size={12} />
          </h3>
          <CheckRow
            label="Contract allowlisted"
            value={call ? "Registry matched" : "Pending"}
            good={Boolean(call)}
          />
          <CheckRow
            label="Evidence fresh"
            value={props.intent ? (freshness ? "Within expiry" : "Expired") : "Pending"}
            good={freshness}
          />
          <CheckRow
            label="Amount within debt"
            value={amountWithinDebt ? "Within limit" : "Review"}
            good={amountWithinDebt}
          />
          <CheckRow label="Slippage check" value="Not applicable (repay)" neutral />
          <CheckRow label="Wallet signature required" value="User signs in wallet" good />
        </article>
        <article className="protect-subcard protect-provenance">
          <h3>
            Data provenance <Icon name="info" size={12} />
          </h3>
          <dl>
            <dt>Risk model</dt>
            <dd>{props.risk ? `${props.risk.model.id}@${props.risk.model.version}` : "Unavailable"}</dd>
            <dt>Model confidence</dt>
            <dd>{props.risk ? `${Math.round(props.risk.confidence.score * 100)}%` : "Unavailable"}</dd>
            <dt>State block</dt>
            <dd>
              {props.intent?.simulation.stateBlock ??
                props.selected.provenance[0]?.blockHeight ??
                "Unavailable"}
            </dd>
            <dt>Intent expires</dt>
            <dd>{props.intent ? formatDate(props.intent.expiresAt) : "After simulation"}</dd>
          </dl>
          <p>
            <Icon name="info" size={14} />
            Simulation calculates exact after-values and creates a short-lived intent before signing.
          </p>
        </article>
      </div>
      {props.submission ? (
        <section className="protect-submission">
          <Icon name="check" size={19} />
          <div>
            <strong>Transaction confirmed</strong>
            <span className="mono">{props.submission.txid}</span>
          </div>
        </section>
      ) : props.intent && props.passed ? (
        <section className="protect-sign">
          <div>
            <strong>{props.isShadow ? "Mainnet preview complete" : "Simulation verified"}</strong>
            <span>
              {props.intent.network} · {props.intent.registryVersion} · expires{" "}
              {formatDate(props.intent.expiresAt)}
            </span>
          </div>
          {props.isShadow ? (
            <button className="btn secondary" disabled>
              Broadcast disabled in shadow mode
            </button>
          ) : (
            <button className="btn primary" disabled={props.submitting} onClick={props.onSign}>
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
function ExecutionRow({
  icon,
  label,
  value,
  good = false,
}: {
  icon: "bridge" | "reports" | "info" | "coins";
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div>
      <Icon name={icon} size={14} />
      <span>{label}</span>
      <strong className={good ? "good" : ""}>{value}</strong>
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
          <h3>{passed ? "Simulation passed" : "Simulation blocked"}</h3>
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
