import { useEffect, useRef, useState } from "react";
import { ToastContainer, toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import type {
  AlertOccurrence,
  AlertRule,
  PortfolioSummary,
  PositionEnvelope,
  RiskFinding,
  TransactionIntent,
  WalletSessionView,
} from "../../../packages/domain/src/index.js";
import { AppShell, COMING_SOON_ROUTES, type Route } from "./components/AppShell.js";
import { LoadingState } from "./components/Ui.js";
import { BridgePage } from "./pages/BridgePage.js";
import { LandingPage } from "./pages/LandingPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PositionsPage } from "./pages/PositionsPage.js";
import { ProtectPage } from "./pages/ProtectPage.js";
import { RiskPage } from "./pages/RiskPage.js";
import { ScopedPage } from "./pages/ScopedPage.js";
import { AlertsPage } from "./pages/AlertsPage.js";
import { IntegrationsPage } from "./pages/IntegrationsPage.js";
import { PricingPage } from "./pages/PricingPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import {
  createAlertRule,
  createWalletChallenge,
  getAlerts,
  getHealth,
  getAddressOverview,
  getPortfolioHistory,
  getSbtcOperations,
  getWalletRequest,
  getWalletSession,
  logoutWalletSession,
  planRepayAction,
  saveRepayIntent,
  recordSubmission,
  verifyWalletChallenge,
  type SbtcOperationView,
  type PortfolioHistoryResponse,
} from "./api.js";
import {
  connectRiskOSWallet,
  disconnectRiskOSWallet,
  sendWalletRequest,
  signOwnershipMessage,
} from "./wallet.js";
import { formatUsd } from "./lib/portfolio.js";
import "./styles.css";

const routes = new Set<Route>([
  "overview",
  "positions",
  "risk",
  "protect",
  "alerts",
  "markets",
  "bridge",
  "rewards",
  "reports",
  "team",
  "integrations",
  "pricing",
  "settings",
]);
type AppRoute = Route | "landing";
const LAST_ANALYZED_ADDRESS_KEY = "riskosfolio:last-analyzed-address:v1";

function persistedAddress(): string {
  try {
    return window.localStorage.getItem(LAST_ANALYZED_ADDRESS_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function rememberAddress(address: string): void {
  try {
    window.localStorage.setItem(LAST_ANALYZED_ADDRESS_KEY, address);
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

function routeFromHash(): AppRoute {
  const value = window.location.hash.replace(/^#\/?/, "");
  if (!value || value === "landing") return "landing";
  if (!routes.has(value as Route)) return "overview";
  if (COMING_SOON_ROUTES.has(value as Route)) return "overview";
  return value as Route;
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const [address, setAddress] = useState(persistedAddress);
  const [addressDraft, setAddressDraft] = useState(persistedAddress);
  const [positions, setPositions] = useState<PositionEnvelope | null>(null);
  const [risks, setRisks] = useState<RiskFinding[]>([]);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [history, setHistory] = useState<PortfolioHistoryResponse | null>(null);
  const [intent, setIntent] = useState<TransactionIntent | null>(null);
  const [bridgeOperations, setBridgeOperations] = useState<SbtcOperationView[]>([]);
  const [bridgeLoaded, setBridgeLoaded] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => Boolean(persistedAddress()));
  const [planning, setPlanning] = useState(false);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [walletSession, setWalletSession] = useState<WalletSessionView | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alertOccurrences, setAlertOccurrences] = useState<AlertOccurrence[]>([]);
  const [alertLoading, setAlertLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submission, setSubmission] = useState<{ state: string; txid: string } | null>(null);
  const [modeLabel, setModeLabel] = useState("Read-only safety active");
  const inspectGeneration = useRef(0);
  const inspectAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    void getHealth()
      .then((health) => {
        if (health.dataMode === "live") {
          setModeLabel(
            health.execution === "advisory-shadow-only"
              ? "Mainnet · advisory protect"
              : "Mainnet reads active",
          );
        } else {
          setModeLabel("Fixture · testnet protect");
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (error) toast.error(error, { toastId: `riskos-error:${error}` });
  }, [error]);

  useEffect(() => {
    if (!intent) return;
    if (intent.status === "ready" && intent.simulation.status === "passed") {
      toast.success("Protection simulation passed", { toastId: "protection-simulation" });
    } else {
      toast.warning("Protection simulation is blocked. Review the evidence and policy checks.", {
        toastId: "protection-simulation",
      });
    }
  }, [intent]);

  useEffect(() => {
    if (submission)
      toast.success("Transaction submitted to the network", { toastId: "transaction-submission" });
  }, [submission]);

  useEffect(() => {
    let cancelled = false;
    void getWalletSession()
      .then(async (session) => {
        if (cancelled) return;
        setWalletSession(session);
        setAddress(session.address);
        setAddressDraft(session.address);
        const alerts = await getAlerts();
        if (cancelled) return;
        setAlertRules(alerts.rules);
        setAlertOccurrences(alerts.occurrences);
        await inspect(session.address, false);
      })
      .catch(() => {
        if (cancelled) return;
        const savedAddress = persistedAddress();
        if (savedAddress) void inspect(savedAddress, false);
      });
    return () => {
      cancelled = true;
      inspectAbort.current?.abort();
    };
  }, []);

  function navigate(nextRoute: Route) {
    const resolved = COMING_SOON_ROUTES.has(nextRoute) ? "overview" : nextRoute;
    window.location.hash = resolved;
    setRoute(resolved);
  }

  async function inspect(nextAddress = addressDraft || address, notify = true) {
    const target = nextAddress.trim();
    if (!target) return;
    inspectAbort.current?.abort();
    const abort = new AbortController();
    inspectAbort.current = abort;
    const generation = ++inspectGeneration.current;
    setAddress(target);
    setAddressDraft(target);
    setLoading(true);
    setError("");
    setIntent(null);
    setBridgeLoaded(false);
    try {
      const overview = await getAddressOverview(target, abort.signal);
      if (generation !== inspectGeneration.current) return;
      setPositions(overview.positions);
      setRisks(overview.risks);
      setSummary(overview.portfolio);
      setLoading(false);
      rememberAddress(target);
      if (notify) toast.success("Portfolio analysis updated", { toastId: "portfolio-analysis" });
      void getPortfolioHistory(target, 30, abort.signal)
        .then((nextHistory) => {
          if (generation !== inspectGeneration.current) return;
          setHistory(nextHistory);
        })
        .catch(() => {
          if (generation !== inspectGeneration.current) return;
          setHistory(null);
        });
    } catch (cause) {
      if (abort.signal.aborted || generation !== inspectGeneration.current) return;
      setPositions(null);
      setRisks([]);
      setSummary(null);
      setHistory(null);
      setError(cause instanceof Error ? cause.message : "Unable to inspect address");
      setLoading(false);
    }
  }

  if (route === "landing") return <LandingPage onLaunch={() => navigate("overview")} />;

  async function protect(positionId: string, amountAtomic: string) {
    setPlanning(true);
    setError("");
    try {
      const nextIntent = await planRepayAction(address, positionId, amountAtomic);
      setIntent(nextIntent);
    } catch (cause) {
      setIntent(null);
      setError(cause instanceof Error ? cause.message : "Unable to create action plan");
    } finally {
      setPlanning(false);
    }
  }

  async function authenticateWallet(refreshConnectedAddress: boolean) {
    const wallet = await connectRiskOSWallet();
    const challenge = await createWalletChallenge(wallet.address);
    const proof = await signOwnershipMessage(challenge.message, challenge.challengeId);
    const session = await verifyWalletChallenge({
      challengeId: challenge.challengeId,
      address: wallet.address,
      ...proof,
    });
    setWalletSession(session);
    const alerts = await getAlerts();
    setAlertRules(alerts.rules);
    setAlertOccurrences(alerts.occurrences);
    if (refreshConnectedAddress) {
      setAddress(wallet.address);
      setAddressDraft(wallet.address);
      await inspect(wallet.address, false);
    }
    return session;
  }

  async function connectWallet() {
    setWalletBusy(true);
    setError("");
    try {
      await authenticateWallet(true);
      toast.success("Wallet connected and portfolio loaded", { toastId: "wallet-session" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet authentication failed");
    } finally {
      setWalletBusy(false);
    }
  }

  function disconnectWallet() {
    void disconnectRiskOSWallet();
    void logoutWalletSession().catch(() => undefined);
    setWalletSession(null);
    setAlertRules([]);
    setAlertOccurrences([]);
    toast.info("Wallet disconnected", { toastId: "wallet-session" });
  }

  async function createAlert(input: Parameters<typeof createAlertRule>[0]) {
    setAlertLoading(true);
    setError("");
    try {
      await createAlertRule(input);
      const alerts = await getAlerts();
      setAlertRules(alerts.rules);
      setAlertOccurrences(alerts.occurrences);
      toast.success("Alert rule created", { toastId: "alert-rule" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create alert rule");
    } finally {
      setAlertLoading(false);
    }
  }

  async function signIntent(_previewIntent: TransactionIntent, positionId: string, amountAtomic: string) {
    setSubmitting(true);
    setError("");
    setSubmission(null);
    try {
      const session = walletSession ?? (await authenticateWallet(false));
      if (session.address !== address) {
        throw new Error("The connected wallet does not own the address used for this protection preview.");
      }
      // Re-read and persist at the authenticated boundary; never promote the
      // public preview directly into an executable wallet request.
      const savedIntent = await saveRepayIntent(address, positionId, amountAtomic);
      setIntent(savedIntent);
      const walletRequest = await getWalletRequest(savedIntent.intentId);
      if (walletRequest.mode === "shadow")
        throw new Error(walletRequest.warnings[0] ?? "This action is in shadow mode");
      const result = await sendWalletRequest(walletRequest);
      const recorded = await recordSubmission(savedIntent.intentId, result.txid);
      setSubmission({ state: recorded.state, txid: recorded.txid });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet request failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function loadBridge() {
    setBridgeLoading(true);
    setError("");
    try {
      const response = await getSbtcOperations(address);
      setBridgeOperations(response.operations);
      setBridgeLoaded(true);
      toast.success(
        response.operations.length
          ? "Bridge lifecycle reconciled"
          : "Bridge lifecycle loaded — no operations found",
        { toastId: "bridge-lifecycle" },
      );
    } catch (cause) {
      setBridgeLoaded(false);
      setError(cause instanceof Error ? cause.message : "Unable to reconcile sBTC operations");
    } finally {
      setBridgeLoading(false);
    }
  }

  const sourceState = loading ? "loading" : error ? "error" : positions ? "ready" : "idle";
  let page;
  if (route === "overview")
    page = (
      <OverviewPage
        address={address}
        addressDraft={addressDraft}
        loading={loading}
        positions={positions}
        risks={risks}
        summary={summary}
        history={history}
        onInspect={() => void inspect()}
        onAddressDraftChange={setAddressDraft}
        onConnect={connectWallet}
        walletBusy={walletBusy}
        onNavigate={navigate}
      />
    );
  else if (route === "positions")
    page = (
      <PositionsPage
        envelope={positions}
        risks={risks}
        summary={summary}
        history={history}
        onInspect={() => void inspect()}
      />
    );
  else if (route === "risk")
    page = (
      <RiskPage
        risks={risks}
        summary={summary}
        envelope={positions}
        onInspect={() => void inspect()}
        onProtect={() => navigate("protect")}
      />
    );
  else if (route === "protect")
    page = (
      <ProtectPage
        envelope={positions}
        risks={risks}
        intent={intent}
        planning={planning}
        onPlan={protect}
        onInspect={() => void inspect()}
        walletConnected={walletSession !== null}
        submitting={submitting}
        submission={submission}
        onSign={signIntent}
      />
    );
  else if (route === "alerts")
    page = (
      <AlertsPage
        connected={walletSession !== null}
        rules={alertRules}
        occurrences={alertOccurrences}
        loading={alertLoading}
        onConnect={connectWallet}
        onCreate={createAlert}
      />
    );
  else if (route === "integrations")
    page = (
      <IntegrationsPage
        address={address}
        apiBaseUrl={
          import.meta.env.VITE_API_URL ?? `${window.location.protocol}//${window.location.hostname}:3001`
        }
        onProtect={() => navigate("protect")}
        onPlans={() => navigate("pricing")}
      />
    );
  else if (route === "pricing")
    page = (
      <PricingPage
        walletConnected={walletSession !== null}
        onConnect={connectWallet}
        onNavigate={(nextRoute) => navigate(nextRoute)}
      />
    );
  else if (route === "reports")
    page = (
      <ReportsPage
        connected={walletSession !== null}
        onConnect={connectWallet}
        onUpgrade={() => navigate("pricing")}
      />
    );
  else if (route === "bridge")
    page = (
      <BridgePage
        operations={bridgeOperations}
        loading={bridgeLoading}
        loaded={bridgeLoaded}
        onLoad={loadBridge}
      />
    );
  else page = <ScopedPage route={route} />;

  if (loading && !positions && route !== "overview") {
    page = (
      <section className="page-state-stage">
        <LoadingState />
      </section>
    );
  }

  return (
    <AppShell
      route={route}
      onRouteChange={navigate}
      address={address}
      addressDraft={addressDraft}
      onAddressDraftChange={setAddressDraft}
      onInspect={() => void inspect()}
      blockHeight={positions?.asOf.stacksBlockHeight ?? null}
      sourceState={sourceState}
      walletConnected={walletSession !== null}
      walletBusy={walletBusy}
      portfolioActive={Boolean(address || positions || loading)}
      alertCount={alertOccurrences.filter((item) => item.state === "open").length}
      modeLabel={modeLabel}
      netWorthLabel={summary ? formatUsd(summary.totalAssetsUsd) : undefined}
      lastUpdatedAt={summary?.data.lastUpdatedAt}
      onWalletConnect={connectWallet}
      onWalletDisconnect={disconnectWallet}
    >
      <ToastContainer
        position="top-right"
        autoClose={4500}
        newestOnTop
        closeOnClick
        pauseOnHover
        theme="light"
      />
      {page}
    </AppShell>
  );
}
