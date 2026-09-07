import { useState } from "react";
import type { AlertOccurrence, AlertRule, RiskFinding } from "../../../../packages/domain/src/index.js";
import { EmptyState, MetricCard, PageHeader, Panel, StatusChip } from "../components/Ui.js";
import { severityTone } from "../lib/portfolio.js";

interface AlertsPageProps {
  connected: boolean;
  rules: AlertRule[];
  occurrences: AlertOccurrence[];
  loading: boolean;
  onConnect: () => void;
  onCreate: (input: {
    name: string;
    categories: RiskFinding["category"][];
    minimumSeverity: RiskFinding["severity"];
  }) => void;
}

export function AlertsPage({ connected, rules, occurrences, loading, onConnect, onCreate }: AlertsPageProps) {
  const [minimumSeverity, setMinimumSeverity] = useState<RiskFinding["severity"]>("medium");
  if (!connected)
    return (
      <>
        <PageHeader
          title="Alerts"
          description="What requires attention now, how severe is it, and which evidence triggered it?"
        />
        <div className="page-state-stage with-heading">
          <EmptyState
            title="Authenticate your wallet"
            description="A one-time signature proves ownership before private alert rules are saved. RiskOS never asks for a seed phrase."
            action={
              <button className="btn primary" onClick={onConnect}>
                Connect wallet
              </button>
            }
          />
        </div>
      </>
    );
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Policy-driven notices deduplicated by rule and current risk evidence."
      />
      <div className="metrics-grid compact">
        <MetricCard
          label="Open alerts"
          value={String(occurrences.filter((item) => item.state === "open").length)}
          detail="Current evidence"
          tone={occurrences.length ? "bad" : "good"}
        />
        <MetricCard label="Rules" value={String(rules.length)} detail="Wallet-owned policies" />
        <MetricCard
          label="High / critical"
          value={String(
            occurrences.filter((item) => item.severity === "high" || item.severity === "critical").length,
          )}
          detail="Review promptly"
          tone="bad"
        />
        <MetricCard label="Delivery" value="In-app" detail="Email/webhook next" />
      </div>
      <div className="two-column primary-layout alert-layout">
        <Panel title="Create monitoring rule" meta="Evaluated immediately">
          <div className="form-grid">
            <label className="full-field">
              Policy name
              <input value="Material portfolio risk" readOnly />
            </label>
            <label className="full-field">
              Minimum severity
              <select
                value={minimumSeverity}
                onChange={(event) => setMinimumSeverity(event.target.value as RiskFinding["severity"])}
              >
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </label>
          </div>
          <p className="form-note">
            Covers liquidation, liquidity, oracle freshness, and bridge evidence. Duplicate findings update
            the existing occurrence.
          </p>
          <button
            className="btn primary full"
            disabled={loading}
            onClick={() =>
              onCreate({
                name: "Material portfolio risk",
                categories: ["liquidation", "liquidity", "oracle", "bridge"],
                minimumSeverity,
              })
            }
          >
            {loading ? "Creating…" : "Create alert rule"}
          </button>
        </Panel>
        <Panel title="Current occurrences" meta={`${occurrences.length} evidence-backed`}>
          {occurrences.length === 0 ? (
            <div className="inline-empty">No current findings meet your policies.</div>
          ) : (
            <div className="finding-list alert-list">
              {occurrences.map((item) => (
                <article key={item.occurrenceId}>
                  <div className={`finding-symbol ${severityTone(item.severity)}`}>!</div>
                  <div>
                    <div className="finding-title">
                      <h3>{item.title}</h3>
                      <StatusChip tone={severityTone(item.severity)}>{item.severity}</StatusChip>
                    </div>
                    <p>
                      {item.evidence.map((evidence) => `${evidence.metric}: ${evidence.value}`).join(" · ")}
                    </p>
                    <small>
                      {item.state} · {new Date(item.updatedAt).toLocaleString()}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
