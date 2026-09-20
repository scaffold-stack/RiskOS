import { useEffect, useState } from "react";
import {
  getAccountPlan,
  getPortfolioEvidenceReport,
  type CommercialPlanView,
} from "../api.js";
import { EmptyState, LoadingState, MetricCard, PageHeader, Panel, StatusChip } from "../components/Ui.js";
import { formatUsd } from "../lib/portfolio.js";

type EvidenceReport = Awaited<ReturnType<typeof getPortfolioEvidenceReport>>;

export function ReportsPage({
  connected,
  onConnect,
  onUpgrade,
}: {
  connected: boolean;
  onConnect: () => void;
  onUpgrade: () => void;
}) {
  const [plan, setPlan] = useState<CommercialPlanView | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [report, setReport] = useState<EvidenceReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!connected) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setLoadingPlan(true);
    void getAccountPlan()
      .then((response) => {
        if (!cancelled) setPlan(response.plan);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load plan");
      })
      .finally(() => {
        if (!cancelled) setLoadingPlan(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connected]);

  async function generate() {
    setGenerating(true);
    setError("");
    try {
      const next = await getPortfolioEvidenceReport();
      setReport(next);
      const blob = new Blob([JSON.stringify(next, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `riskosfolio-${next.address}-${next.generatedAt.slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to generate report");
    } finally {
      setGenerating(false);
    }
  }

  if (!connected)
    return (
      <>
        <PageHeader
          title="Evidence reports"
          description="Export the exact current portfolio, risk, provenance, and confidence evidence for the wallet that signs in."
        />
        <EmptyState
          title="Authenticate the report owner"
          description="A wallet signature is required so a report cannot be generated for a different owner under your paid plan."
          action={<button className="btn primary" onClick={onConnect}>Connect wallet</button>}
        />
      </>
    );

  if (loadingPlan)
    return (
      <section className="page-state-stage">
        <LoadingState />
      </section>
    );

  const entitled = plan?.features.includes("reports") ?? false;
  if (!entitled)
    return (
      <>
        <PageHeader
          title="Evidence reports"
          description="Owner-authenticated exports preserve the current portfolio, findings, provenance, and confidence state."
        />
        <EmptyState
          title="Reports are included with Pro"
          description="Free inspection remains available. Upgrade to generate downloadable evidence reports and access deeper canonical history."
          action={<button className="btn primary" onClick={onUpgrade}>Compare plans</button>}
        />
      </>
    );

  return (
    <>
      <PageHeader
        title="Evidence reports"
        description="Generate an owner-authenticated JSON artifact from current canonical evidence. Reports never imply custody, audit assurance, or transaction authorization."
        actions={<StatusChip tone="healthy">{plan?.name ?? "Paid"}</StatusChip>}
      />
      {report ? (
        <div className="metrics-grid compact">
          <MetricCard label="Net value" value={formatUsd(report.portfolio.netWorthUsd)} detail="Current evidence" />
          <MetricCard label="Risk score" value={String(report.portfolio.risk.score)} detail={report.portfolio.risk.classification} />
          <MetricCard label="Positions" value={String(report.positions.positions.length)} detail="Included records" />
          <MetricCard label="Findings" value={String(report.risks.length)} detail="Evidence-backed" />
        </div>
      ) : null}
      <div className="two-column primary-layout">
        <Panel title="Generate current report" meta={plan?.name ?? "Paid plan"}>
          <p className="form-note">
            The export includes the meaning-first portfolio summary, normalized positions, risk findings,
            source provenance, confidence, warnings, and the report integrity statement.
          </p>
          <button className="btn primary full" disabled={generating} onClick={() => void generate()}>
            {generating ? "Resolving current evidence…" : report ? "Refresh and download JSON" : "Generate and download JSON"}
          </button>
          {error ? <p className="form-error">{error}</p> : null}
        </Panel>
        <Panel title="Integrity boundary" meta="riskos.report.v1">
          <ul className="pricing-features report-integrity-list">
            <li>Wallet ownership must be authenticated.</li>
            <li>Every position preserves source provenance and confidence.</li>
            <li>Missing or unsupported evidence remains visible.</li>
            <li>Mainnet protective actions remain advisory-only.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
