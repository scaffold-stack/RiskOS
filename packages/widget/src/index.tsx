import { useEffect, useState, type CSSProperties } from "react";
import { RiskOsClient, type PortfolioSummary, type RiskFinding } from "../../client/src/index.js";

export interface RiskOsWidgetProps {
  apiBaseUrl: string;
  address: string;
  theme?: "stacks" | "host";
  onProtect?: (positionId: string) => void;
  onOpenDetails?: () => void;
}

const stacksTheme: CSSProperties = {
  fontFamily: '"DM Sans", Arial, sans-serif',
  color: "#131416",
  background: "#fdfdfc",
  border: "1px solid #eae7e1",
  borderRadius: 16,
  padding: 16,
};

function severityColor(severity: RiskFinding["severity"]) {
  if (severity === "critical" || severity === "high") return "#ea384c";
  if (severity === "medium") return "#ff9100";
  return "#178a63";
}

/**
 * Embeddable portfolio/risk panel for wallets and protocol UIs.
 * Does not reproduce the full RiskOSfolio app — severity, capital at risk, one explanation, one action.
 */
export function RiskOsWidget({ apiBaseUrl, address, theme = "stacks", onProtect, onOpenDetails }: RiskOsWidgetProps) {
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [topRisk, setTopRisk] = useState<RiskFinding | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const client = new RiskOsClient({ baseUrl: apiBaseUrl });
    setLoading(true);
    Promise.all([client.getPortfolio(address), client.getRisk(address)])
      .then(([portfolio, risk]) => {
        if (cancelled) return;
        setSummary(portfolio);
        setTopRisk([...risk.risks].sort((a, b) => b.score - a.score)[0] ?? null);
        setError("");
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Unable to load RiskOS");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiBaseUrl, address]);

  const style = theme === "stacks" ? stacksTheme : { ...stacksTheme, background: "transparent" };

  if (loading) return <div style={style}>Loading RiskOS evidence…</div>;
  if (error) return <div style={style}><strong>RiskOS unavailable</strong><p>{error}</p></div>;
  if (!summary) return <div style={style}>No portfolio evidence for this address.</div>;

  return (
    <section style={style} aria-label="RiskOSfolio embedded risk panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "#818688", textTransform: "uppercase", fontWeight: 600 }}>RiskOSfolio</div>
          <strong style={{ fontSize: 18 }}>{summary.risk.classification}</strong>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: "#818688" }}>Score</div>
          <strong style={{ color: "#fc6432", fontSize: 22 }}>{summary.risk.score}</strong>
        </div>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.4 }}>{summary.centralAnswer.canGoWrong}</p>
      <div style={{ display: "grid", gap: 6, fontSize: 13, marginBottom: 14 }}>
        <div><span style={{ color: "#818688" }}>Capital at risk </span><strong>{summary.risk.capitalAtRiskUsd ? `$${summary.risk.capitalAtRiskUsd}` : "Not calculated"}</strong></div>
        <div><span style={{ color: "#818688" }}>Freshness </span><strong>{summary.data.state} · block {summary.data.stacksBlockHeight}</strong></div>
        {topRisk && (
          <div style={{ color: severityColor(topRisk.severity) }}>
            {topRisk.severity}: {topRisk.meaning}
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => onOpenDetails?.()}
          style={{ flex: 1, height: 40, borderRadius: 10, border: "1px solid #eae7e1", background: "#fff", cursor: "pointer" }}
        >
          View details
        </button>
        <button
          type="button"
          onClick={() => onProtect?.(topRisk?.positionId ?? summary.risk.drivers[0]?.positionId ?? "")}
          style={{ flex: 1, height: 40, borderRadius: 10, border: 0, background: "#fc6432", color: "#fff", cursor: "pointer" }}
        >
          Protect position
        </button>
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 11, color: "#818688" }}>
        Advisory only — RiskOS never custodies funds. Mainnet execution remains shadow/advisory.
      </p>
    </section>
  );
}
