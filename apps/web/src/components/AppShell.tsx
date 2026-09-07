import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icons.js";
import { shortAddress } from "../lib/portfolio.js";

export type Route =
  | "overview"
  | "positions"
  | "risk"
  | "protect"
  | "alerts"
  | "markets"
  | "bridge"
  | "rewards"
  | "reports"
  | "team"
  | "integrations"
  | "settings";

const primary: Array<{ route: Route; label: string; icon: IconName }> = [
  { route: "overview", label: "Overview", icon: "overview" },
  { route: "positions", label: "Positions", icon: "positions" },
  { route: "risk", label: "Risk", icon: "risk" },
  { route: "protect", label: "Protect", icon: "protect" },
  { route: "alerts", label: "Alerts", icon: "alerts" },
];

const secondary: Array<{ route: Route; label: string; icon: IconName }> = [
  { route: "markets", label: "Markets", icon: "markets" },
  { route: "bridge", label: "Bridge", icon: "bridge" },
  { route: "rewards", label: "Rewards", icon: "rewards" },
  { route: "reports", label: "Reports", icon: "reports" },
  { route: "team", label: "Team", icon: "team" },
  { route: "integrations", label: "Integrations", icon: "integrations" },
  { route: "settings", label: "Settings", icon: "settings" },
];

interface AppShellProps {
  route: Route;
  onRouteChange: (route: Route) => void;
  address: string;
  addressDraft: string;
  onAddressDraftChange: (value: string) => void;
  onInspect: () => void;
  blockHeight: number | null;
  sourceState: "idle" | "loading" | "ready" | "error";
  walletConnected: boolean;
  walletBusy: boolean;
  portfolioActive: boolean;
  alertCount: number;
  modeLabel?: string | undefined;
  netWorthLabel?: string | undefined;
  lastUpdatedAt?: string | undefined;
  warning?: string | undefined;
  onWalletConnect: () => void;
  onWalletDisconnect: () => void;
  children: ReactNode;
}

export function AppShell({
  route,
  onRouteChange,
  address,
  addressDraft,
  onAddressDraftChange,
  onInspect,
  blockHeight,
  sourceState,
  walletConnected,
  walletBusy,
  portfolioActive,
  alertCount,
  modeLabel = "Mainnet · advisory protect",
  lastUpdatedAt,
  warning,
  onWalletConnect,
  onWalletDisconnect,
  children,
}: AppShellProps) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <button
          className="logo inverse"
          onClick={() => onRouteChange("overview")}
          aria-label="RiskOSfolio overview"
        >
          <img src="/logo-inverse.svg" alt="" />
          <span>
            RiskOS<sup>folio</sup>
          </span>
        </button>
        <nav className="nav-block" aria-label="Primary">
          {primary.map((item) => (
            <button
              key={item.route}
              className={`nav-link ${route === item.route ? "active" : ""}`}
              onClick={() => onRouteChange(item.route)}
              aria-current={route === item.route ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.route === "alerts" && alertCount > 0 ? <b className="nav-pill">{alertCount}</b> : null}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <nav className="nav-block" aria-label="Secondary">
          {secondary.map((item) => (
            <button
              key={item.route}
              className={`nav-link ${route === item.route ? "active" : ""}`}
              onClick={() => onRouteChange(item.route)}
              aria-current={route === item.route ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="system-card">
          <div className="system-row">
            <i className={`status-dot ${sourceState === "error" ? "error" : ""}`} />
            {sourceState === "error"
              ? "Source needs attention"
              : sourceState === "ready"
                ? "All systems operational"
                : modeLabel}
          </div>
          <div className="system-meta">RiskOSfolio v1.0</div>
          <div className="system-tagline mono">
            BITCOIN CAPITAL.
            <br />
            LOWER RISK.
            <br />
            HIGHER CONVICTION.
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {portfolioActive ? (
            <>
              <div className="top-left">
                <form
                  className="inspect-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onInspect();
                  }}
                >
                  <input
                    className="portfolio-select"
                    value={addressDraft}
                    onChange={(event) => onAddressDraftChange(event.target.value.trim())}
                    aria-label="Stacks address"
                    spellCheck={false}
                  />
                  <button
                    className="copy-address"
                    type="button"
                    aria-label="Copy address"
                    onClick={() => void navigator.clipboard?.writeText(addressDraft)}
                  >
                    <Icon name="copy" size={17} />
                  </button>
                </form>
                <div className="data-fresh">
                  <span className="live-label">
                    <i className={`status-dot ${sourceState === "error" ? "error" : ""}`} />
                    {sourceState === "loading" ? "Syncing" : "Live"}
                  </span>
                  <span>
                    {blockHeight ? `Stacks block ${blockHeight.toLocaleString()}` : shortAddress(address)}
                  </span>
                  {lastUpdatedAt ? (
                    <>
                      <b>•</b>
                      <span>Last updated: {formatUtc(lastUpdatedAt)}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="top-right">
                {warning ? (
                  <div className="top-warning" title={warning}>
                    <strong>!</strong>
                    <span>{warning}</span>
                  </div>
                ) : null}
                <button
                  className="btn secondary small refresh-button"
                  type="button"
                  onClick={onInspect}
                  disabled={sourceState === "loading"}
                >
                  <Icon name="refresh" size={16} /> {sourceState === "loading" ? "Refreshing…" : "Refresh"}
                </button>
                <button
                  className="btn primary small"
                  disabled={walletBusy}
                  onClick={walletConnected ? onWalletDisconnect : onWalletConnect}
                >
                  <Icon name="wallet" size={16} />
                  {walletBusy ? "Authenticating…" : walletConnected ? "Wallet connected" : "Connect wallet"}
                </button>
              </div>
            </>
          ) : (
            <div className="topbar-onboarding">
              <span className="live-label">
                <i className="status-dot" />
                Public mainnet preview
              </span>
              <span>Paste an address or connect a wallet to begin</span>
            </div>
          )}
        </header>
        {children}
      </main>

      <nav className="mobile-bar" aria-label="Mobile">
        {primary.map((item) => (
          <button
            key={item.route}
            className={`mobile-link ${route === item.route ? "active" : ""}`}
            onClick={() => onRouteChange(item.route)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function formatUtc(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}
