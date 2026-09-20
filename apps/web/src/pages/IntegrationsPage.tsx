import { useEffect, useMemo, useState } from "react";
import { RiskOsWidget } from "../../../../packages/widget/src/index.js";
import { Icon, type IconName } from "../components/Icons.js";
import { PageHeader, StatusChip } from "../components/Ui.js";
import {
  createAccountApiKey,
  getAccountApiKeys,
  revokeAccountApiKey,
  type AccountApiKeysResponse,
} from "../api.js";

type DeveloperTab = "quickstart" | "access" | "explorer" | "reference" | "widget" | "guides";
type Access = "Public" | "API key" | "Wallet session" | "Paid wallet";

interface SdkMethod {
  name: string;
  group: "Portfolio" | "Risk" | "Yield" | "Authentication" | "Alerts" | "Protect" | "Commercial";
  signature: string;
  description: string;
  access: Access;
}

const sdkMethods: SdkMethod[] = [
  { name: "getOverview", group: "Portfolio", signature: "(address, options?)", description: "Positions, risks, and meaning-first portfolio in one coalesced discovery.", access: "Public" },
  { name: "getPositions", group: "Portfolio", signature: "(address, options?)", description: "Normalized wallet, lending, supply, and liquidity positions with provenance.", access: "Public" },
  { name: "getPortfolio", group: "Portfolio", signature: "(address, options?)", description: "Capital allocation, valued subtotals, scenarios, and risk posture.", access: "Public" },
  { name: "getHistory", group: "Portfolio", signature: "(address, { limit }, options?)", description: "Canonical, reorg-safe position observations and protocol cash flows.", access: "API key" },
  { name: "getSbtcOperations", group: "Portfolio", signature: "(address, options?)", description: "Reconciled sBTC deposit and withdrawal lifecycle evidence.", access: "Public" },
  { name: "getDemoAddress", group: "Portfolio", signature: "(options?)", description: "Returns the environment's known demonstration address.", access: "Public" },
  { name: "getRisk", group: "Risk", signature: "(address, options?)", description: "Deterministic liquidation, liquidity, oracle, bridge, and support findings.", access: "Public" },
  { name: "getPortfolioEvidenceReport", group: "Risk", signature: "(options?)", description: "Owner-authenticated report containing current portfolio and evidence.", access: "Paid wallet" },
  { name: "getYieldMarkets", group: "Yield", signature: "(options?)", description: "Current allowlisted market universe with rates, confidence, and capacity.", access: "Public" },
  { name: "getYieldStrategies", group: "Yield", signature: "(options?)", description: "Evidence-derived earning strategies with explore and recommendation availability.", access: "Public" },
  { name: "createYieldAllocation", group: "Yield", signature: "({ capitalUsd, days, mode }, options?)", description: "Evidence-labeled simulation or corroborated recommendation.", access: "API key" },
  { name: "createWalletChallenge", group: "Authentication", signature: "(address, options?)", description: "Creates a one-time, domain-bound Stacks ownership message.", access: "Public" },
  { name: "verifyWalletChallenge", group: "Authentication", signature: "(proof, options?)", description: "Verifies ownership and creates a short-lived httpOnly session.", access: "Public" },
  { name: "getWalletSession", group: "Authentication", signature: "(options?)", description: "Reads the current authenticated wallet session.", access: "Wallet session" },
  { name: "logoutWalletSession", group: "Authentication", signature: "(options?)", description: "Revokes the current wallet session.", access: "Wallet session" },
  { name: "getAlerts", group: "Alerts", signature: "(options?)", description: "Lists wallet-owned policies and deduplicated occurrences.", access: "Wallet session" },
  { name: "createAlertRule", group: "Alerts", signature: "(rule, options?)", description: "Saves and immediately evaluates an evidence-backed alert policy.", access: "Wallet session" },
  { name: "planRepay", group: "Protect", signature: "(address, positionId, amountAtomic, options?)", description: "Creates a stateless repayment preflight; mainnet remains advisory.", access: "Public" },
  { name: "saveRepayIntent", group: "Protect", signature: "(address, positionId, amountAtomic, options?)", description: "Recalculates and persists an owner-authenticated intent.", access: "Wallet session" },
  { name: "getWalletRequest", group: "Protect", signature: "(intentId, options?)", description: "Revalidates an intent before returning an allowed wallet request.", access: "Wallet session" },
  { name: "recordSubmission", group: "Protect", signature: "(intentId, txid, options?)", description: "Records a wallet-returned testnet transaction for reconciliation.", access: "Wallet session" },
  { name: "health", group: "Commercial", signature: "(options?)", description: "Service mode, registry, pricing quorum, and execution boundary.", access: "Public" },
  { name: "getPlans", group: "Commercial", signature: "(options?)", description: "Current plan catalogue and enforceable product limits.", access: "Public" },
  { name: "getDeveloperUsage", group: "Commercial", signature: "(options?)", description: "Current API-key allowance, usage, and renewal period.", access: "API key" },
  { name: "getAccountPlan", group: "Commercial", signature: "(options?)", description: "Effective wallet plan and entitlement information.", access: "Wallet session" },
  { name: "getAccountApiKeys", group: "Commercial", signature: "(options?)", description: "Lists wallet-owned keys and their current monthly usage.", access: "Wallet session" },
  { name: "createAccountApiKey", group: "Commercial", signature: "(name, options?)", description: "Creates a wallet-owned API key and returns its secret once.", access: "Paid wallet" },
  { name: "revokeAccountApiKey", group: "Commercial", signature: "(keyId, options?)", description: "Permanently revokes an API key owned by the wallet.", access: "Paid wallet" },
];

const workflows: Array<{ icon: IconName; title: string; description: string; methods: string }> = [
  { icon: "overview", title: "Portfolio intelligence", description: "Build a complete address dashboard from one coalesced request.", methods: "getOverview · getHistory" },
  { icon: "shield", title: "Risk monitoring", description: "Explain current risks and persist owner-controlled alert policies.", methods: "getRisk · createAlertRule" },
  { icon: "chart", title: "Yield research", description: "Compare allowlisted markets without inventing rates or capacity.", methods: "getYieldMarkets · createYieldAllocation" },
  { icon: "protect", title: "Protective preflight", description: "Simulate a repayment and preserve its evidence boundary.", methods: "planRepay · saveRepayIntent" },
];

const explorerEndpoints = [
  { id: "overview", label: "Address overview", method: "GET", path: (address: string) => `/v1/address/${encodeURIComponent(address)}/overview` },
  { id: "risk", label: "Risk findings", method: "GET", path: (address: string) => `/v1/address/${encodeURIComponent(address)}/risk` },
  { id: "portfolio", label: "Portfolio summary", method: "GET", path: (address: string) => `/v1/address/${encodeURIComponent(address)}/portfolio` },
  { id: "markets", label: "Yield markets", method: "GET", path: () => "/v1/yield/markets" },
  { id: "strategies", label: "Yield strategies", method: "GET", path: () => "/v1/yield/strategies" },
  { id: "plans", label: "Product plans", method: "GET", path: () => "/v1/plans" },
  { id: "health", label: "Service health", method: "GET", path: () => "/health" },
] as const;

const quickstartCode = `import { RiskOsClient } from "@riskos/client";

const riskos = new RiskOsClient({
  baseUrl: process.env.RISKOS_API_URL!,
  apiKey: process.env.RISKOS_API_KEY!,
  timeoutMs: 10_000,
  retries: 2,
});

const overview = await riskos.getOverview("SP...");
console.log(overview.portfolio.risk.classification);`;

const browserCode = `const riskos = new RiskOsClient({
  baseUrl: "https://api.riskos.example",
  credentials: "include",
});

const challenge = await riskos.createWalletChallenge(address);
// Sign challenge.message with a supported Stacks wallet.
const session = await riskos.verifyWalletChallenge(proof);`;

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  }
  return (
    <div className="dev-code-shell">
      <div className="dev-code-head">
        <span>{label}</span>
        <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`}>
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function AccessBadge({ access }: { access: Access }) {
  return <span className={`dev-access ${access.toLowerCase().replaceAll(" ", "-")}`}>{access}</span>;
}

export function IntegrationsPage({
  address,
  apiBaseUrl,
  walletConnected,
  onConnect,
  onProtect,
  onPlans,
}: {
  address: string;
  apiBaseUrl: string;
  walletConnected: boolean;
  onConnect: () => Promise<void>;
  onProtect: () => void;
  onPlans: () => void;
}) {
  const [tab, setTab] = useState<DeveloperTab>("quickstart");
  const [methodQuery, setMethodQuery] = useState("");
  const [methodGroup, setMethodGroup] = useState("All");
  const [explorerEndpoint, setExplorerEndpoint] = useState<(typeof explorerEndpoints)[number]["id"]>("overview");
  const [explorerAddress, setExplorerAddress] = useState(address);
  const [explorerResult, setExplorerResult] = useState("");
  const [explorerStatus, setExplorerStatus] = useState("");
  const [explorerBusy, setExplorerBusy] = useState(false);
  const [widgetTheme, setWidgetTheme] = useState<"stacks" | "host">("stacks");
  const [access, setAccess] = useState<AccountApiKeysResponse | null>(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState("");

  useEffect(() => {
    if (tab !== "access" || !walletConnected) return;
    let cancelled = false;
    setAccessLoading(true);
    setAccessError("");
    void getAccountApiKeys()
      .then((response) => {
        if (!cancelled) setAccess(response);
      })
      .catch((cause) => {
        if (!cancelled) setAccessError(cause instanceof Error ? cause.message : "Unable to load API access");
      })
      .finally(() => {
        if (!cancelled) setAccessLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, walletConnected]);

  async function createKey() {
    if (!newKeyName.trim()) return;
    setCreatingKey(true);
    setAccessError("");
    try {
      const created = await createAccountApiKey(newKeyName.trim());
      setNewSecret(created.apiKey);
      setNewKeyName("");
      setAccess(await getAccountApiKeys());
    } catch (cause) {
      setAccessError(cause instanceof Error ? cause.message : "Unable to create API key");
    } finally {
      setCreatingKey(false);
    }
  }

  async function revokeKey(keyId: string) {
    if (!window.confirm("Revoke this API key? Applications using it will immediately lose access.")) return;
    setRevokingKeyId(keyId);
    setAccessError("");
    try {
      await revokeAccountApiKey(keyId);
      setAccess(await getAccountApiKeys());
    } catch (cause) {
      setAccessError(cause instanceof Error ? cause.message : "Unable to revoke API key");
    } finally {
      setRevokingKeyId("");
    }
  }

  const filteredMethods = useMemo(() => {
    const query = methodQuery.trim().toLowerCase();
    return sdkMethods.filter(
      (method) =>
        (methodGroup === "All" || method.group === methodGroup) &&
        (!query ||
          method.name.toLowerCase().includes(query) ||
          method.description.toLowerCase().includes(query) ||
          method.signature.toLowerCase().includes(query)),
    );
  }, [methodGroup, methodQuery]);

  async function runExplorer() {
    const endpoint = explorerEndpoints.find((item) => item.id === explorerEndpoint)!;
    if (["overview", "risk", "portfolio"].includes(endpoint.id) && !explorerAddress.trim()) {
      setExplorerStatus("Address required");
      return;
    }
    setExplorerBusy(true);
    setExplorerStatus("Requesting…");
    setExplorerResult("");
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${apiBaseUrl}${endpoint.path(explorerAddress.trim())}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Preserve non-JSON gateway responses for diagnosis.
      }
      setExplorerResult(formatted);
      setExplorerStatus(`${response.status} ${response.statusText} · ${Math.round(performance.now() - startedAt)}ms`);
    } catch (cause) {
      setExplorerStatus(cause instanceof DOMException && cause.name === "AbortError" ? "Timed out after 15s" : "Network request failed");
      setExplorerResult(cause instanceof Error ? cause.message : String(cause));
    } finally {
      window.clearTimeout(timer);
      setExplorerBusy(false);
    }
  }

  const selectedEndpoint = explorerEndpoints.find((item) => item.id === explorerEndpoint)!;
  const groups = ["All", ...new Set(sdkMethods.map((method) => method.group))];

  return (
    <>
      <PageHeader
        title="Developer console"
        description="Build evidence-backed Bitcoin portfolio, risk, monitoring, yield, reporting, and advisory protection workflows with one typed SDK."
        actions={
          <div className="dev-head-actions">
            <a
              className="btn secondary small"
              href="https://github.com/RiskOSfolio/RiskOS/blob/main/openapi/riskos.v1.yaml"
              target="_blank"
              rel="noreferrer"
            >
              OpenAPI
            </a>
            <button className="btn primary small" onClick={onPlans}>Get API access</button>
          </div>
        }
      />

      <section className="dev-hero">
        <div className="dev-hero-copy">
          <div className="dev-kicker"><span /> @riskos/client · v0.4.0</div>
          <h2>From address to actionable evidence.</h2>
          <p>
            A standalone TypeScript SDK for Stacks wallets, protocols, treasury tools, and research products.
            Public inspection stays open; commercial capacity and deeper evidence use server-side keys.
          </p>
          <div className="dev-install">
            <code>npm install @riskos/client</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText("npm install @riskos/client")}>
              <Icon name="copy" size={15} /> Copy
            </button>
          </div>
        </div>
        <div className="dev-stats" aria-label="SDK capabilities">
          <div><strong>{sdkMethods.length}</strong><span>typed methods</span></div>
          <div><strong>7</strong><span>workflow domains</span></div>
          <div><strong>15s</strong><span>default timeout</span></div>
          <div><strong>0</strong><span>custodied funds</span></div>
        </div>
      </section>

      <nav className="dev-tabs" aria-label="Developer console sections">
        {([
          ["quickstart", "Quickstart"],
          ["access", "API access"],
          ["explorer", "API explorer"],
          ["reference", "SDK reference"],
          ["widget", "Widget"],
          ["guides", "Guides"],
        ] as Array<[DeveloperTab, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
            aria-current={tab === value ? "page" : undefined}
          >
            {label}
            {value === "reference" ? <span>{sdkMethods.length}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "quickstart" ? (
        <div className="dev-section-stack">
          <section className="dev-quickstart-grid">
            <div>
              <div className="dev-section-label">01 · INSTALL AND INITIALIZE</div>
              <h2>One client, explicit safety defaults.</h2>
              <p className="dev-section-copy">
                GET requests retry transient failures. State-changing POST requests never retry automatically.
                Decimal monetary values remain strings so accounting code does not inherit floating-point errors.
              </p>
              <div className="dev-safety-list">
                <div><Icon name="check" size={16} /><span>Typed success and RFC-style problem responses</span></div>
                <div><Icon name="check" size={16} /><span>AbortSignal, timeouts, and bounded backoff</span></div>
                <div><Icon name="check" size={16} /><span>Server-side keys and wallet-owned browser sessions</span></div>
              </div>
            </div>
            <CodeBlock code={quickstartCode.replace('"SP..."', JSON.stringify(address || "SP..."))} label="server.ts" />
          </section>

          <section>
            <div className="dev-section-heading">
              <div>
                <div className="dev-section-label">02 · COMPOSE WORKFLOWS</div>
                <h2>Use the SDK as infrastructure, not just a data feed.</h2>
              </div>
              <button className="btn secondary small" onClick={() => setTab("reference")}>Browse all methods</button>
            </div>
            <div className="dev-workflow-grid">
              {workflows.map((workflow) => (
                <article key={workflow.title}>
                  <div className="dev-workflow-icon"><Icon name={workflow.icon} size={19} /></div>
                  <h3>{workflow.title}</h3>
                  <p>{workflow.description}</p>
                  <code>{workflow.methods}</code>
                </article>
              ))}
            </div>
          </section>

          <section className="dev-boundary">
            <Icon name="shield" size={24} />
            <div>
              <strong>Mainnet execution is not part of the SDK promise.</strong>
              <p>Protect methods produce advisory shadow results on mainnet. Keys unlock capacity and evidence—not custody, guaranteed returns, or hidden transaction authority.</p>
            </div>
            <StatusChip tone="caution">Advisory mainnet</StatusChip>
          </section>
        </div>
      ) : null}

      {tab === "access" ? (
        <section className="dev-access-page">
          <div className="dev-access-intro">
            <div>
              <div className="dev-section-label">WALLET-OWNED CREDENTIALS</div>
              <h2>API access and usage</h2>
              <p>Create, inspect, and revoke production keys. Secrets are returned once and are never stored in plaintext.</p>
            </div>
            {walletConnected ? <StatusChip tone="healthy">Wallet verified</StatusChip> : <StatusChip tone="caution">Wallet required</StatusChip>}
          </div>

          {!walletConnected ? (
            <div className="dev-access-gate">
              <div className="dev-workflow-icon"><Icon name="wallet" size={20} /></div>
              <h3>Verify the wallet that owns the subscription</h3>
              <p>A signed ownership challenge protects key creation, usage data, and revocation. RiskOS never asks for a seed phrase.</p>
              <button className="btn primary" onClick={() => void onConnect()}>Connect and verify wallet</button>
            </div>
          ) : accessLoading && !access ? (
            <div className="dev-access-gate"><p>Loading API access…</p></div>
          ) : access ? (
            <>
              <div className="dev-access-summary">
                <div><span>Current plan</span><strong>{access.plan.name}</strong></div>
                <div><span>Monthly capacity</span><strong>{access.plan.apiRequestsMonthly.toLocaleString()}</strong></div>
                <div><span>Active keys</span><strong>{access.keys.filter((item) => item.key.status === "active").length} / {access.maximumActiveKeys}</strong></div>
                <div><span>Renewal</span><strong>UTC monthly</strong></div>
              </div>

              {newSecret ? (
                <div className="dev-secret-once">
                  <div>
                    <div className="dev-section-label">COPY THIS SECRET NOW</div>
                    <strong>This API key will not be shown again.</strong>
                  </div>
                  <code>{newSecret}</code>
                  <button className="btn primary small" onClick={() => void navigator.clipboard?.writeText(newSecret)}>
                    <Icon name="copy" size={14} /> Copy key
                  </button>
                  <button className="btn secondary small" onClick={() => setNewSecret("")}>I stored it safely</button>
                </div>
              ) : null}

              {access.canCreate ? (
                <div className="dev-key-create">
                  <div>
                    <h3>Create an API key</h3>
                    <p>
                      Use a name that identifies its environment or service. Your plan allows{" "}
                      {access.maximumActiveKeys} active {access.maximumActiveKeys === 1 ? "key" : "keys"}.
                    </p>
                  </div>
                  <input
                    value={newKeyName}
                    onChange={(event) => setNewKeyName(event.target.value)}
                    placeholder="e.g. Production backend"
                    maxLength={100}
                  />
                  <button className="btn primary" disabled={creatingKey || !newKeyName.trim()} onClick={() => void createKey()}>
                    {creatingKey ? "Creating…" : "Create key"}
                  </button>
                </div>
              ) : (
                <div className="dev-upgrade-access">
                  <div>
                    <strong>API key creation is not included in {access.plan.name}.</strong>
                    <p>API Growth includes 50,000 metered requests, recommendation mode, extended history, SDK use, and embeds.</p>
                  </div>
                  <button className="btn primary" onClick={onPlans}>Compare API plans</button>
                </div>
              )}

              <div className="dev-key-list">
                <div className="dev-section-heading">
                  <div>
                    <div className="dev-section-label">CREDENTIALS</div>
                    <h2>{access.keys.length ? "Your API keys" : "No API keys yet"}</h2>
                  </div>
                </div>
                {access.keys.map(({ key, usage }) => {
                  const percentage = Math.min(100, (usage.requestCount / Math.max(1, usage.monthlyRequestLimit)) * 100);
                  return (
                    <article key={key.keyId}>
                      <div className="dev-key-details">
                        <div>
                          <div className="dev-key-name"><strong>{key.name}</strong><AccessBadge access="API key" /></div>
                          <code>{key.keyPrefix}••••••••••••••••••••</code>
                        </div>
                        <span className={`dev-key-state ${key.status}`}>{key.status}</span>
                      </div>
                      <div className="dev-key-usage">
                        <div><span>{usage.requestCount.toLocaleString()} used</span><span>{usage.remaining.toLocaleString()} remaining</span></div>
                        <div className="dev-usage-track"><i style={{ width: `${percentage}%` }} /></div>
                      </div>
                      <div className="dev-key-meta">
                        <span>Created {new Date(key.createdAt).toLocaleDateString()}</span>
                        <span>{key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}` : "Never used"}</span>
                        {key.status === "active" ? (
                          <button disabled={revokingKeyId === key.keyId} onClick={() => void revokeKey(key.keyId)}>
                            {revokingKeyId === key.keyId ? "Revoking…" : "Revoke"}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : null}
          {accessError ? <div className="dev-access-error">{accessError}</div> : null}
        </section>
      ) : null}

      {tab === "explorer" ? (
        <section className="dev-explorer">
          <div className="dev-explorer-controls">
            <div className="dev-section-label">LIVE READ-ONLY CONSOLE</div>
            <h2>Inspect the API before integrating.</h2>
            <p>These requests use the public boundary and never expose or store an API key in the browser.</p>
            <label>
              Endpoint
              <select value={explorerEndpoint} onChange={(event) => setExplorerEndpoint(event.target.value as typeof explorerEndpoint)}>
                {explorerEndpoints.map((endpoint) => <option value={endpoint.id} key={endpoint.id}>{endpoint.label}</option>)}
              </select>
            </label>
            {["overview", "risk", "portfolio"].includes(explorerEndpoint) ? (
              <label>
                Stacks address
                <input value={explorerAddress} onChange={(event) => setExplorerAddress(event.target.value)} placeholder="SP… or SM…" />
              </label>
            ) : null}
            <div className="dev-request-line">
              <span>{selectedEndpoint.method}</span>
              <code>{selectedEndpoint.path(explorerAddress || "SP…")}</code>
            </div>
            <button className="btn primary" disabled={explorerBusy} onClick={() => void runExplorer()}>
              <Icon name="arrow" size={15} />
              {explorerBusy ? "Running request…" : "Run request"}
            </button>
            <small>Anonymous limits apply. Use a server-side Developer key for commercial capacity.</small>
          </div>
          <div className="dev-response">
            <div className="dev-code-head">
              <span>Response</span>
              <b className={explorerStatus.startsWith("2") ? "success" : ""}>{explorerStatus || "Not run"}</b>
            </div>
            <pre>{explorerResult || `{\n  "ready": true,\n  "instruction": "Choose an endpoint and run the request."\n}`}</pre>
          </div>
        </section>
      ) : null}

      {tab === "reference" ? (
        <section className="dev-reference">
          <div className="dev-reference-toolbar">
            <div>
              <div className="dev-section-label">TYPED SDK SURFACE</div>
              <h2>{filteredMethods.length} methods</h2>
            </div>
            <div className="dev-reference-filters">
              <div className="dev-search">
                <Icon name="search" size={15} />
                <input value={methodQuery} onChange={(event) => setMethodQuery(event.target.value)} placeholder="Search methods…" />
              </div>
              <select value={methodGroup} onChange={(event) => setMethodGroup(event.target.value)}>
                {groups.map((group) => <option key={group}>{group}</option>)}
              </select>
            </div>
          </div>
          <div className="dev-method-list">
            {filteredMethods.map((method) => (
              <article key={method.name}>
                <div className="dev-method-main">
                  <div>
                    <span className="dev-method-group">{method.group}</span>
                    <h3>{method.name}<code>{method.signature}</code></h3>
                  </div>
                  <AccessBadge access={method.access} />
                </div>
                <p>{method.description}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tab === "widget" ? (
        <section className="dev-widget-layout">
          <div className="dev-widget-config">
            <div className="dev-section-label">REACT EMBED</div>
            <h2>Configure the risk panel.</h2>
            <p>The widget uses one overview request and disables its protection CTA when no actionable position exists.</p>
            <label>
              Theme
              <div className="dev-toggle-row">
                <button className={widgetTheme === "stacks" ? "active" : ""} onClick={() => setWidgetTheme("stacks")}>RiskOSfolio</button>
                <button className={widgetTheme === "host" ? "active" : ""} onClick={() => setWidgetTheme("host")}>Host surface</button>
              </div>
            </label>
            <div className="dev-origin-note">
              <Icon name="info" size={17} />
              <span>Add every approved browser host to <code>WEB_ORIGIN</code>. Never place a paid API key in widget code.</span>
            </div>
            <CodeBlock
              label="RiskPanel.tsx"
              code={`<RiskOsWidget\n  apiBaseUrl="${apiBaseUrl}"\n  address="${address || "SP..."}"\n  theme="${widgetTheme}"\n  onOpenDetails={openRisk}\n  onProtect={openProtect}\n/>`}
            />
          </div>
          <div className={`dev-widget-stage ${widgetTheme}`}>
            <div className="dev-widget-stage-head">
              <span>Live preview</span>
              <b>{address ? "Public evidence" : "Address required"}</b>
            </div>
            {address ? (
              <RiskOsWidget
                apiBaseUrl={apiBaseUrl}
                address={address}
                theme={widgetTheme}
                onOpenDetails={() => { window.location.hash = "risk"; }}
                onProtect={onProtect}
              />
            ) : (
              <div className="dev-widget-empty">Analyze an address to load the widget preview.</div>
            )}
          </div>
        </section>
      ) : null}

      {tab === "guides" ? (
        <section className="dev-guides">
          <div className="dev-guide-intro">
            <div className="dev-section-label">INTEGRATION GUIDES</div>
            <h2>Choose the trust boundary first.</h2>
            <p>Public reads, server API keys, and wallet sessions solve different problems. Do not mix their credentials.</p>
          </div>
          <div className="dev-guide-grid">
            <article>
              <span>01</span><Icon name="layers" size={20} />
              <h3>Server integration</h3>
              <p>Use an API key for commercial capacity, recommendation mode, and extended history.</p>
              <CodeBlock code={quickstartCode} label="Node / server" />
            </article>
            <article>
              <span>02</span><Icon name="wallet" size={20} />
              <h3>Wallet ownership</h3>
              <p>Use a signed challenge and httpOnly cookie for alerts, reports, and saved intents.</p>
              <CodeBlock code={browserCode} label="Browser session" />
            </article>
            <article>
              <span>03</span><Icon name="link" size={20} />
              <h3>CORS and embeds</h3>
              <p>Allowlist known widget origins. Proxy paid requests through your server so secrets never reach browsers.</p>
              <div className="dev-guide-points">
                <div><b>Browser</b><span>Public reads or wallet cookies</span></div>
                <div><b>Server</b><span>API key and usage metering</span></div>
                <div><b>Cookie</b><span>Same registrable HTTPS domain</span></div>
              </div>
            </article>
            <article>
              <span>04</span><Icon name="info" size={20} />
              <h3>Errors and reliability</h3>
              <p>Every SDK failure exposes structured fields for support and safe retry decisions.</p>
              <div className="dev-error-fields">
                {["status", "code", "detail", "requestId", "retryAfterSeconds"].map((field) => <code key={field}>{field}</code>)}
              </div>
              <p className="dev-guide-small">GET: bounded retry · POST: no automatic retry · default timeout: 15 seconds</p>
            </article>
          </div>
        </section>
      ) : null}
    </>
  );
}
