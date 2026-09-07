import type { SbtcOperationView } from "../api.js";
import { MeaningCallout } from "../components/Charts.js";
import { EmptyState, PageHeader, Panel, StatusChip } from "../components/Ui.js";
import { ProtocolIcon } from "../components/ProtocolIcon.js";

const STEPS = [
  "requested",
  "signer-accepted",
  "bitcoin-confirming",
  "stacks-completed-bitcoin-unverified",
  "completed",
] as const;

function stepIndex(state: SbtcOperationView["state"]): number {
  if (state === "failed" || state === "evidence-conflict") return -1;
  return STEPS.indexOf(state as (typeof STEPS)[number]);
}

function meaningFor(operation: SbtcOperationView): string {
  if (operation.state === "completed") {
    return "Stacks and Bitcoin evidence agree. Capital is considered finalized for this operation.";
  }
  if (operation.state === "evidence-conflict") {
    return "Sources disagree. Do not treat Emily alone as final — wait for matching chain evidence or open a support bundle.";
  }
  if (operation.state === "failed") {
    return "Terminal failure path. Prefer the official recovery flow; RiskOS will not invent a refund.";
  }
  if (operation.state === "bitcoin-confirming") {
    return "Bitcoin confirmations are still accumulating. Capital is pending and unavailable for other protective actions.";
  }
  return "Bridge workflow is in progress. Compare waiting time against normal finality before initiating new bridge volume.";
}

export function BridgePage({
  operations,
  loading,
  loaded,
  onLoad,
}: {
  operations: SbtcOperationView[];
  loading: boolean;
  loaded: boolean;
  onLoad: () => void;
}) {
  return (
    <>
      <PageHeader
        title="sBTC bridge"
        description="Is capital pending, how long has it waited, and what should you do if it stalls?"
        actions={
          <button className="btn secondary small" onClick={onLoad} disabled={loading}>
            {loading ? "Reconciling…" : "Refresh lifecycle"}
          </button>
        }
      />
      <MeaningCallout
        question="Three-source finality"
        answer="Emily status alone never marks an operation complete. Canonical completion requires matching Stacks registry events and confirmed Bitcoin evidence."
        tone="caution"
      />
      {!loaded ? (
        <div className="page-state-stage with-context">
          <EmptyState
            title="Bridge evidence not loaded"
            description="Load bridge activity for the currently selected Stacks address."
            action={
              <button className="btn primary" onClick={onLoad} disabled={loading}>
                {loading ? "Loading…" : "Load bridge lifecycle"}
              </button>
            }
          />
        </div>
      ) : operations.length === 0 ? (
        <div className="page-state-stage with-context">
          <EmptyState
            title="No bridge operations found"
            description="No indexed sBTC deposits or withdrawals are associated with this address — or indexing has not reached them yet."
          />
        </div>
      ) : (
        <Panel title="Bridge operations" meta={`${operations.length} reconciled operations`}>
          <div className="operation-list">
            {operations.map((operation) => {
              const active = stepIndex(operation.state);
              return (
                <article key={operation.operationKey} className="bridge-card">
                  <div className="operation-icon">
                    <ProtocolIcon protocol="sbtc" size={30} />
                  </div>
                  <div>
                    <strong>{operation.direction}</strong>
                    <small>{operation.operationKey}</small>
                    <p>{meaningFor(operation)}</p>
                    {operation.reasons.map((reason) => (
                      <small key={reason}>{reason}</small>
                    ))}
                    <div className="bridge-stepper" aria-label="Bridge stages">
                      {STEPS.map((step, index) => (
                        <span key={step} className={active >= index ? "done" : ""}>
                          {step.replaceAll("-", " ")}
                        </span>
                      ))}
                    </div>
                  </div>
                  <StatusChip
                    tone={
                      operation.state === "completed"
                        ? "healthy"
                        : operation.state === "failed" || operation.state === "evidence-conflict"
                          ? "critical"
                          : "caution"
                    }
                  >
                    {operation.state}
                  </StatusChip>
                  <span className="number">
                    {operation.bitcoin.length} BTC evidence record{operation.bitcoin.length === 1 ? "" : "s"}
                  </span>
                </article>
              );
            })}
          </div>
        </Panel>
      )}
    </>
  );
}
