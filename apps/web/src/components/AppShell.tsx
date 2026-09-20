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
  | "pricing"
  | "settings";

const primary: Array<{ route: Route; label: string; icon: IconName }> = [
  { route: "overview", label: "Overview", icon: "overview" },
  { route: "positions", label: "Positions", icon: "positions" },
  { route: "risk", label: "Risk", icon: "risk" },
  { route: "protect", label: "Protect", icon: "protect" },
  { route: "alerts", label: "Alerts", icon: "alerts" },
];

const enabledSecondary: Array<{ route: Route; label: string; icon: IconName }> = [
  { route: "reports", label: "Reports", icon: "reports" },
  { route: "integrations", label: "Developers", icon: "integrations" },
  { route: "pricing", label: "Plans", icon: "rewards" },
];

const comingSoon: Array<{ route: Route; label: string; icon: IconName }> = [
  { route: "markets", label: "Markets", icon: "markets" },
  { route: "bridge", label: "Bridge", icon: "bridge" },
  { route: "rewards", label: "Rewards", icon: "rewards" },
  { route: "team", label: "Team", icon: "team" },
  { route: "settings", label: "Settings", icon: "settings" },
];

export const COMING_SOON_ROUTES = new Set<Route>(comingSoon.map((item) => item.route));

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
              {item.route === "alerts" && alertCount > 0 ? (
                <b className="nav-soon">{alertCount > 99 ? "99+" : alertCount}</b>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <nav className="nav-block" aria-label="Developer and plans">
          {enabledSecondary.map((item) => (
            <button
              key={item.route}
              className={`nav-link ${route === item.route ? "active" : ""}`}
              onClick={() => onRouteChange(item.route)}
              aria-current={route === item.route ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.route === "pricing" ? <b className="nav-soon">Plans</b> : null}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <nav className="nav-block" aria-label="Coming soon">
          {comingSoon.map((item) => (
            <button
              key={item.route}
              type="button"
              className="nav-link coming-soon"
              disabled
              title="Coming soon"
              aria-disabled="true"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <b className="nav-soon">Soon</b>
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
                  <div className="inspect-input-wrap">
                    <input
                      className="portfolio-select"
                      value={addressDraft}
                      onChange={(event) => onAddressDraftChange(event.target.value)}
                      aria-label="Stacks address"
                      placeholder="SP… or SM…"
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                    />
                    <button
                      className="copy-address"
                      type="button"
                      aria-label="Copy address"
                      disabled={!addressDraft.trim()}
                      onClick={() => void navigator.clipboard?.writeText(addressDraft.trim())}
                    >
                      <Icon name="copy" size={17} />
                    </button>
                  </div>
                  <button
                    className="btn primary small analyze-button"
                    type="submit"
                    disabled={!addressDraft.trim() || sourceState === "loading"}
                  >
                    <Icon name="search" size={16} />
                    {sourceState === "loading" ? "Analyzing…" : "Analyze"}
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
