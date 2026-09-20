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
  color: "#09271d",
  background: "#ffffff",
  border: "1px solid #dceae3",
  borderRadius: 14,
  padding: 16,
};

function severityColor(severity: RiskFinding["severity"]) {
  if (severity === "critical" || severity === "high") return "#c63f52";
  if (severity === "medium") return "#bd721c";
  return "#087a50";
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
    const controller = new AbortController();
    const client = new RiskOsClient({ baseUrl: apiBaseUrl });
    setLoading(true);
    client.getOverview(address, { signal: controller.signal })
      .then((overview) => {
        if (cancelled) return;
        setSummary(overview.portfolio);
        setTopRisk([...overview.risks].sort((a, b) => b.score - a.score)[0] ?? null);
        setError("");
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Unable to load RiskOS");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [apiBaseUrl, address]);

  const style = theme === "stacks" ? stacksTheme : { ...stacksTheme, background: "transparent" };

  if (loading) return <div style={style}>Loading RiskOS evidence…</div>;
  if (error) return <div style={style}><strong>RiskOS unavailable</strong><p>{error}</p></div>;
  if (!summary) return <div style={style}>No portfolio evidence for this address.</div>;
  const protectPositionId = topRisk?.positionId ?? summary.risk.drivers[0]?.positionId ?? "";
  const protectionAvailable = Boolean(protectPositionId);

  return (
    <section style={style} aria-label="RiskOSfolio embedded risk panel">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "#5f736a", textTransform: "uppercase", fontWeight: 600 }}>RiskOSfolio</div>
          <strong style={{ fontSize: 18 }}>{summary.risk.classification}</strong>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: "#5f736a" }}>Score</div>
          <strong style={{ color: topRisk ? severityColor(topRisk.severity) : "#087a50", fontSize: 22 }}>{summary.risk.score}</strong>
        </div>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.4 }}>{summary.centralAnswer.canGoWrong}</p>
      <div style={{ display: "grid", gap: 6, fontSize: 13, marginBottom: 14 }}>
        <div><span style={{ color: "#5f736a" }}>Capital at risk </span><strong>{summary.risk.capitalAtRiskUsd ? `$${summary.risk.capitalAtRiskUsd}` : "Not calculated"}</strong></div>
        <div><span style={{ color: "#5f736a" }}>Freshness </span><strong>{summary.data.state} · block {summary.data.stacksBlockHeight}</strong></div>
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
          style={{ flex: 1, height: 40, borderRadius: 10, border: "1px solid #dceae3", background: "#fff", color: "#09271d", cursor: "pointer" }}
        >
          View details
        </button>
        <button
          type="button"
          disabled={!protectionAvailable}
          onClick={() => protectionAvailable && onProtect?.(protectPositionId)}
          style={{ flex: 1, height: 40, borderRadius: 10, border: 0, background: protectionAvailable ? "#12a66f" : "#dceae3", color: protectionAvailable ? "#fff" : "#5f736a", cursor: protectionAvailable ? "pointer" : "not-allowed" }}
        >
          {protectionAvailable ? "Protect position" : "No action needed"}
        </button>
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 11, color: "#5f736a" }}>
        Advisory only — RiskOS never custodies funds. Mainnet execution remains shadow/advisory.
      </p>
    </section>
  );
}
