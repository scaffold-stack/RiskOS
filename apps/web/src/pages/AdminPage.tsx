import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createAdminSession,
  getAdminOverview,
  hasAdminSession,
  logoutAdminSession,
  type AdminOverview,
  type AdminWindow,
} from "../api.js";
import { MetricCard, Panel, StatusChip, type StatusTone } from "../components/Ui.js";

function statusTone(state: string): StatusTone {
  if (state === "live" || state === "green" || state === "complete" || state === "streaming")
    return "healthy";
  if (state === "broken" || state === "red" || state === "failed" || state === "interrupted")
    return "critical";
  return "caution";
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let next = value / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && next >= 1024; index++) {
    next /= 1024;
    unit = units[index]!;
  }
  return `${next.toFixed(next >= 100 ? 0 : 1)} ${unit}`;
}

function formatTime(value: string | null): string {
  if (!value) return "Not available";
  return new Date(value).toLocaleString();
}

function compactRoute(route: string): string {
  return route.replace("/v1/", "").replaceAll("/", " / ");
}

function RequestChart({ data }: { data: AdminOverview["timeline"] }) {
  const points = useMemo(() => {
    if (data.length === 0) return "";
    const maximum = Math.max(1, ...data.map((point) => point.requests));
    return data
      .map((point, index) => {
        const x = data.length === 1 ? 50 : (index / (data.length - 1)) * 100;
        const y = 34 - (point.requests / maximum) * 30;
        return `${x},${y}`;
      })
      .join(" ");
  }, [data]);
  return (
    <div className="admin-request-chart" aria-label="Request volume over time">
      {points ? (
        <svg viewBox="0 0 100 38" preserveAspectRatio="none" role="img">
          <defs>
            <linearGradient id="admin-volume-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#12a66f" stopOpacity=".28" />
              <stop offset="1" stopColor="#12a66f" stopOpacity=".02" />
            </linearGradient>
          </defs>
          <polygon points={`0,38 ${points} 100,38`} fill="url(#admin-volume-fill)" />
          <polyline points={points} fill="none" stroke="#0b9968" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="admin-chart-empty">Analytics begin after this deployment.</div>
      )}
    </div>
  );
}

export function AdminPage() {
  const [authenticated, setAuthenticated] = useState(hasAdminSession);
  const [password, setPassword] = useState("");
  const [window, setWindow] = useState<AdminWindow>("24h");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(authenticated);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    try {
      setOverview(await getAdminOverview(window));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load operations analytics");
      if (!hasAdminSession()) {
        setAuthenticated(false);
        setOverview(null);
      }
    } finally {
      setLoading(false);
    }
  }, [authenticated, window]);

  useEffect(() => {
    void load();
    if (!authenticated) return;
    const interval = window === "24h" ? windowThis.setInterval(() => void load(), 30_000) : null;
    return () => {
      if (interval !== null) windowThis.clearInterval(interval);
    };
  }, [authenticated, load, window]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await createAdminSession(password);
      setPassword("");
      setAuthenticated(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Access denied");
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    await logoutAdminSession();
    setAuthenticated(false);
    setOverview(null);
  }

  if (!authenticated) {
    return (
      <main className="admin-login-page">
        <section className="admin-login-card">
          <img src="/logo.svg" alt="RiskOSfolio" />
          <span className="admin-eyebrow">Private operations</span>
          <h1>Unified monitoring</h1>
          <p>Authenticate to inspect production activity, chain ingestion, API usage, database state, and platform failures.</p>
          <form onSubmit={(event) => void login(event)}>
            <label htmlFor="admin-password">Admin password</label>
            <input
              id="admin-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
              required
            />
            {error ? <div className="admin-error" role="alert">{error}</div> : null}
            <button className="btn primary" disabled={loading || !password}>
              {loading ? "Verifying…" : "Open monitoring"}
            </button>
          </form>
          <small>Password verification uses a salted server-side scrypt hash. The plaintext is never stored.</small>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-topbar">
        <a href="/" className="admin-brand"><img src="/logo.svg" alt="RiskOSfolio" /></a>
        <div>
          <span className="admin-eyebrow">Private operations</span>
          <h1>Platform control room</h1>
        </div>
        <div className="admin-top-actions">
          <div className="admin-window-tabs">
            {(["24h", "7d", "30d"] as const).map((value) => (
              <button key={value} className={window === value ? "active" : ""} onClick={() => setWindow(value)}>
                {value}
              </button>
            ))}
          </div>
          <button className="btn secondary small" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn secondary small" onClick={() => void logout()}>Lock</button>
        </div>
      </header>

      {error ? <div className="admin-error admin-page-error" role="alert">{error}</div> : null}
      {!overview ? (
        <section className="admin-loading">Loading production telemetry…</section>
      ) : (
        <div className="admin-content">
          <section className="admin-status-strip">
            <div>
              <StatusChip tone={statusTone(overview.overallState)}>{overview.overallState}</StatusChip>
              <strong>RiskOSfolio production</strong>
              <span>Generated {formatTime(overview.generatedAt)}</span>
            </div>
            <div className="mono">
              Block {overview.chain.chainhook?.lastBlock?.toLocaleString() ?? overview.chain.canonicalTip?.height.toLocaleString() ?? "—"}
            </div>
          </section>

          <section className="admin-metrics">
            <MetricCard label="Unique addresses" value={formatNumber(overview.traffic.uniqueAddresses)} detail={`${formatNumber(overview.traffic.addressSearches)} searches`} />
            <MetricCard label="API requests" value={formatNumber(overview.traffic.requests)} detail={`${overview.window} window`} />
            <MetricCard label="Error rate" value={`${overview.traffic.errorRatePercent.toFixed(2)}%`} detail={`${formatNumber(overview.traffic.errors)} failed requests`} tone={overview.traffic.errorRatePercent > 5 ? "bad" : "good"} />
            <MetricCard label="P95 latency" value={`${formatNumber(overview.traffic.p95LatencyMs)} ms`} detail={`${formatNumber(overview.traffic.averageLatencyMs)} ms average`} tone={overview.traffic.p95LatencyMs > 2_000 ? "bad" : "good"} />
            <MetricCard label="Active wallets" value={formatNumber(overview.workflows.activeWalletSessions)} detail={`${formatNumber(overview.traffic.walletLogins)} sign-ins`} />
            <MetricCard label="Active API keys" value={formatNumber(overview.workflows.activeApiKeys)} detail={`${formatNumber(overview.workflows.monthlyApiKeyRequests)} monthly requests`} />
            <MetricCard label="Canonical events" value={formatNumber(overview.database.canonicalContractEvents)} detail={`${formatNumber(overview.database.canonicalProjections)} projections`} />
            <MetricCard label="Projection issues" value={formatNumber(overview.database.projectionIssues)} detail="Canonical unresolved evidence" tone={overview.database.projectionIssues ? "bad" : "good"} />
          </section>

          <section className="admin-grid admin-grid-primary">
            <Panel title="Request activity" meta={`${overview.window} · auto-refresh`}>
              <RequestChart data={overview.timeline} />
              <div className="admin-chart-summary">
                <span><b>{formatNumber(overview.traffic.requests)}</b> requests</span>
                <span><b>{formatNumber(overview.traffic.addressSearches)}</b> searches</span>
                <span><b>{formatNumber(overview.workflows.reportsGenerated)}</b> reports</span>
                <span><b>{formatNumber(overview.workflows.alertsCreated)}</b> alerts</span>
              </div>
            </Panel>
            <Panel title="Live / degraded / broken" meta="Current module state">
              <div className="admin-module-list">
                {overview.modules.map((module) => (
                  <div key={module.name}>
                    <StatusChip tone={statusTone(module.state)}>{module.state}</StatusChip>
                    <span><strong>{module.name}</strong><small>{module.detail}</small></span>
                  </div>
                ))}
              </div>
            </Panel>
          </section>

          <section className="admin-grid">
            <Panel title="Chain and source health" meta={overview.chain.chainhook?.uuid ?? "No hook configured"}>
              <div className="admin-health-list">
                <div>
                  <span>Hiro Chainhook</span>
                  <StatusChip tone={statusTone(overview.chain.chainhook?.state ?? "unknown")}>
                    {overview.chain.chainhook?.enabled ? overview.chain.chainhook.state : "disabled"}
                  </StatusChip>
                  <b>{overview.chain.chainhook?.occurrenceCount.toLocaleString() ?? "—"} deliveries</b>
                </div>
                {overview.chain.sources.map((source) => (
                  <div key={source.sourceId}>
                    <span>{source.sourceId}</span>
                    <StatusChip tone={statusTone(source.state)}>{source.state}</StatusChip>
                    <b>{source.observedHeight?.toLocaleString() ?? "No height"} · lag {source.lagBlocks ?? "—"}</b>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Runtime and database" meta={overview.deployment.provider}>
              <dl className="admin-definition-list">
                <div><dt>Deployment</dt><dd>{overview.deployment.app ?? "Local"} · {overview.deployment.region ?? "—"}</dd></div>
                <div><dt>Machine</dt><dd className="mono">{overview.deployment.machineId ?? "—"}</dd></div>
                <div><dt>API uptime</dt><dd>{Math.floor(overview.api.uptimeSeconds / 3600)}h {Math.floor((overview.api.uptimeSeconds % 3600) / 60)}m</dd></div>
                <div><dt>Database size</dt><dd>{formatBytes(overview.database.sizeBytes)}</dd></div>
                <div><dt>Connections</dt><dd>{overview.database.activeConnections}</dd></div>
                <div><dt>Registry</dt><dd>{overview.registry.activeVersion ?? "Unavailable"}</dd></div>
              </dl>
            </Panel>
          </section>

          <Panel title="Historical backfill" meta={`${overview.backfills.length} registered contracts`}>
            <div className="table-wrap">
              <table className="data-table admin-table">
                <thead><tr><th>Contract</th><th>Status</th><th>Offset</th><th>Pages</th><th>Events</th><th>Transactions</th><th>Updated</th></tr></thead>
                <tbody>
                  {overview.backfills.map((backfill) => (
                    <tr key={backfill.contractPrincipal}>
                      <td className="mono" title={backfill.contractPrincipal}>{backfill.contractPrincipal.split(".").at(-1)}</td>
                      <td><StatusChip tone={statusTone(backfill.status)}>{backfill.status}</StatusChip></td>
                      <td>{backfill.nextOffset.toLocaleString()}</td>
                      <td>{backfill.pagesCompleted.toLocaleString()}</td>
                      <td>{backfill.eventsSeen.toLocaleString()}</td>
                      <td>{backfill.transactionsIngested.toLocaleString()}</td>
                      <td>{formatTime(backfill.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <section className="admin-grid">
            <Panel title="API endpoint health" meta="Most requested routes">
              <div className="table-wrap">
                <table className="data-table admin-table">
                  <thead><tr><th>Route</th><th>Requests</th><th>Errors</th><th>Average</th><th>P95</th></tr></thead>
                  <tbody>
                    {overview.endpoints.map((endpoint) => (
                      <tr key={endpoint.route}>
                        <td className="mono">{compactRoute(endpoint.route)}</td>
                        <td>{endpoint.requests.toLocaleString()}</td>
                        <td>{endpoint.errors.toLocaleString()}</td>
                        <td>{endpoint.averageLatencyMs.toFixed(0)} ms</td>
                        <td>{endpoint.p95LatencyMs.toFixed(0)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel title="Recent platform activity" meta="No raw wallet addresses stored">
              <div className="admin-activity-list">
                {overview.recentActivity.map((event, index) => (
                  <div key={`${event.occurredAt}:${index}`}>
                    <i className={event.statusCode >= 400 ? "critical" : "healthy"} />
                    <span><strong>{event.eventKind.replaceAll("-", " ")}</strong><small>{event.method} · {compactRoute(event.route)} · {event.actorKind}</small></span>
                    <b>{event.statusCode} · {event.durationMs} ms</b>
                    <time>{formatTime(event.occurredAt)}</time>
                  </div>
                ))}
                {overview.recentActivity.length === 0 ? <p className="admin-empty">Activity will appear as production requests arrive.</p> : null}
              </div>
            </Panel>
          </section>
        </div>
      )}
    </main>
  );
}

const windowThis = window;
