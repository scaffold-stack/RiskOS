import type {
  AlertOccurrence,
  AlertRule,
  PortfolioSummary,
  PositionEnvelope,
  RiskFinding,
  TransactionIntent,
  WalletChallenge,
  WalletSessionView,
  WalletTransactionRequest,
} from "../../../packages/domain/src/index.js";
import {
  clearWalletSession,
  readWalletSessionToken,
  writeWalletSession,
} from "./lib/walletSessionStorage.js";

const API_URL =
  import.meta.env.VITE_API_URL ??
  (typeof window === "undefined"
    ? "http://127.0.0.1:3001"
    : `${window.location.protocol}//${window.location.hostname}:3001`);
const walletSessionStorage = browserSessionStorage();
let walletSessionToken: string | null = readWalletSessionToken(walletSessionStorage);

function browserSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function forgetWalletSession() {
  walletSessionToken = null;
  clearWalletSession(walletSessionStorage);
}

export interface SbtcOperationView {
  operationKey: string;
  direction: "deposit" | "withdrawal";
  state:
    | "requested"
    | "signer-accepted"
    | "bitcoin-confirming"
    | "stacks-completed-bitcoin-unverified"
    | "completed"
    | "failed"
    | "evidence-conflict";
  canonical: boolean;
  reasons: string[];
  bitcoin: Array<{ txid: string; confirmations: number; confirmed: boolean }>;
}

export interface PortfolioHistoryResponse {
  address: string;
  observations: Array<{
    indexBlockHash: string;
    blockHeight: number;
    observedAt: string;
    registryVersion: string;
    positions: PositionEnvelope["positions"];
    valuedNetSubtotalUsd: string | null;
    valuedAssetsSubtotalUsd: string | null;
    valuedDebtSubtotalUsd: string | null;
    valuedPositionCount: number;
    excludedPositionCount: number;
    complete: boolean;
  }>;
  cashFlows: Array<{
    protocol: "zest" | "bitflow";
    kind: string;
    blockHeight: number;
    indexBlockHash: string;
    transactionId: string;
    positionKey: string;
    amounts: Record<string, unknown>;
  }>;
  integrity: {
    canonicalOnly: true;
    reorgInvalidatedSnapshotsExcluded: true;
    state: "observations-available" | "baseline-only" | "no-baseline";
  };
  earnedYield: {
    valueUsd: null;
    state: "attribution-required" | "cash-flow-history-required";
    meaning: string;
  };
}

export interface YieldMarketView {
  id: string;
  protocol: string;
  kind: "lending" | "liquidity" | "stacking";
  assets: string;
  annualizedRateBps: number | null;
  rateLabel: "Supply APR" | "Fee APR" | "Reward APY";
  evidenceState: "verified" | "provider-reported" | "unavailable";
  confidenceScore: number;
  observedAtBlock: number | null;
  observedAt: string;
  tvlUsd: string | null;
  independentRateEvidence: {
    source: string;
    observedAt: string;
    annualizedRateBps: number;
    differenceBps: number;
  } | null;
  capacityEvidence: { source: string; observedAt: string; tvlUsd: string } | null;
  source: string;
  meaning: string;
  eligibleForAllocation: boolean;
  allocationExclusionReason?: string | null;
}

export interface YieldAllocationPlanView {
  capitalUsd: string;
  days: 30 | 90 | 365;
  mode?: "explore" | "recommend";
  allocatedUsd: string;
  unallocatedUsd: string;
  projectedGrossEarningsUsd: string;
  weightedAnnualizedRateBps: number;
  generatedAt: string;
  evidenceAsOf: string | null;
  allocations: Array<{
    marketId: string;
    protocol: string;
    kind: YieldMarketView["kind"];
    assets: string;
    amountUsd: string;
    shareBps: number;
    annualizedRateBps: number;
    rateLabel: YieldMarketView["rateLabel"];
    projectedGrossEarningsUsd: string;
    evidenceState: YieldMarketView["evidenceState"];
    confidenceScore: number;
    observedAt: string;
    observedAtBlock: number | null;
    reportedTvlUsd: string | null;
    reportedTvlCapacityUsd: string | null;
    source: string;
    independentRateEvidence: YieldMarketView["independentRateEvidence"];
    capacityEvidence: YieldMarketView["capacityEvidence"];
  }>;
  markets: YieldMarketView[];
  policy: {
    objective: string;
    maximumProtocolShareBps: number;
    maximumMarketShareBps: number;
    maximumPoolTvlShareBps: number;
  };
  warnings: string[];
}

export interface CommercialPlanView {
  id: "free" | "pro" | "treasury" | "developer" | "protocol";
  name: string;
  audience: string;
  priceUsdMonthly: number | null;
  apiRequestsMonthly: number;
  maxAlertRules: number;
  maxWallets: number;
  features: string[];
  highlights: string[];
}

export interface PlansResponse {
  currency: "USD";
  billingState: "manual-provisioning";
  plans: CommercialPlanView[];
  executionFeesEnabled: false;
}

export interface AccountApiKey {
  keyId: string;
  keyPrefix: string;
  ownerAddress: string | null;
  name: string;
  plan: CommercialPlanView["id"];
  status: "active" | "revoked";
  monthlyRequestLimit: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AccountApiKeysResponse {
  plan: CommercialPlanView;
  entitlement: { endsAt: string | null } | null;
  canCreate: boolean;
  maximumActiveKeys: number;
  keys: Array<{
    key: AccountApiKey;
    usage: {
      periodStart: string;
      requestCount: number;
      monthlyRequestLimit: number;
      remaining: number;
    };
  }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(walletSessionToken ? { authorization: `Bearer ${walletSessionToken}` } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401 && payload.code === "WALLET_SESSION_REQUIRED") forgetWalletSession();
    throw new Error(payload.detail ?? payload.title ?? "Request failed");
  }
  return payload as T;
}

export function createWalletChallenge(address: string) {
  return request<WalletChallenge>("/v1/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
}

export function verifyWalletChallenge(input: {
  challengeId: string;
  address: string;
  publicKey: string;
  signature: string;
}) {
  return request<WalletSessionView & { token: string }>("/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((session) => {
    walletSessionToken = session.token;
    writeWalletSession(walletSessionStorage, { token: session.token, expiresAt: session.expiresAt });
    return session;
  });
}

export function getWalletSession() {
  return request<WalletSessionView>("/v1/auth/session");
}
export async function logoutWalletSession() {
  try {
    const response = await fetch(`${API_URL}/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: walletSessionToken ? { authorization: `Bearer ${walletSessionToken}` } : {},
    });
    if (!response.ok) throw new Error("Unable to close the wallet session");
  } finally {
    forgetWalletSession();
  }
}

export function getHealth() {
  return request<{
    status: string;
    dataMode: string;
    network?: string;
    registryMode?: string;
    execution: string;
    pricing?: string;
    modules?: Record<string, string>;
  }>("/health");
}

export function getPlans() {
  return request<PlansResponse>("/v1/plans");
}

export function getAccountPlan() {
  return request<{ plan: CommercialPlanView; entitlement: { endsAt: string | null } | null }>("/v1/account/plan");
}

export function getAccountApiKeys() {
  return request<AccountApiKeysResponse>("/v1/account/api-keys");
}

export function createAccountApiKey(name: string) {
  return request<{ apiKey: string; key: AccountApiKey }>("/v1/account/api-keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function revokeAccountApiKey(keyId: string) {
  return request<{ keyId: string; status: "revoked" }>(
    `/v1/account/api-keys/${encodeURIComponent(keyId)}/revoke`,
    { method: "POST" },
  );
}

export function getPortfolioEvidenceReport() {
  return request<{
    schemaVersion: "riskos.report.v1";
    generatedAt: string;
    address: string;
    plan: "pro" | "treasury" | "protocol";
    portfolio: PortfolioSummary;
    positions: PositionEnvelope;
    risks: RiskFinding[];
    integrity: {
      walletOwnershipAuthenticated: true;
      currentEvidenceOnly: true;
      advisoryOnly: boolean;
      meaning: string;
    };
  }>("/v1/reports/portfolio");
}

export function getPositions(address: string) {
  return request<PositionEnvelope>(`/v1/address/${encodeURIComponent(address)}/positions`);
}

export function getRisks(address: string) {
  return request<{ risks: RiskFinding[] }>(`/v1/address/${encodeURIComponent(address)}/risk`);
}

export function getPortfolioSummary(address: string) {
  return request<PortfolioSummary>(`/v1/address/${encodeURIComponent(address)}/portfolio`);
}

export function getAddressOverview(address: string, signal?: AbortSignal) {
  return request<{
    address: string;
    positions: PositionEnvelope;
    risks: RiskFinding[];
    portfolio: PortfolioSummary;
  }>(`/v1/address/${encodeURIComponent(address)}/overview`, signal ? { signal } : undefined);
}

export function getPortfolioHistory(address: string, limit = 30, signal?: AbortSignal) {
  return request<PortfolioHistoryResponse>(
    `/v1/address/${encodeURIComponent(address)}/history?limit=${limit}`,
    signal ? { signal } : undefined,
  );
}

export function getYieldAllocation(
  capitalUsd: string,
  days: 30 | 90 | 365,
  signal?: AbortSignal,
  mode: "explore" | "recommend" = "explore",
) {
  return request<YieldAllocationPlanView>("/v1/yield/allocations", {
    method: "POST",
    body: JSON.stringify({ capitalUsd, days, mode }),
    ...(signal ? { signal } : {}),
  });
}

export function planRepayAction(address: string, positionId: string, amountAtomic: string) {
  return request<TransactionIntent>("/v1/actions/plan", {
    method: "POST",
    body: JSON.stringify({ address, positionId, action: "repay", amountAtomic }),
  });
}

export function saveRepayIntent(address: string, positionId: string, amountAtomic: string) {
  return request<TransactionIntent>("/v1/actions/intents", {
    method: "POST",
    body: JSON.stringify({ address, positionId, action: "repay", amountAtomic }),
  });
}

export function getSbtcOperations(address: string) {
  return request<{ address: string; operations: SbtcOperationView[] }>(
    `/v1/address/${encodeURIComponent(address)}/sbtc-operations`,
  );
}

export interface AlertsResponse {
  address: string;
  rules: AlertRule[];
  occurrences: AlertOccurrence[];
}
export function getAlerts() {
  return request<AlertsResponse>("/v1/alerts");
}
export function createAlertRule(input: {
  name: string;
  categories: RiskFinding["category"][];
  minimumSeverity: RiskFinding["severity"];
}) {
  return request<{ rule: AlertRule; occurrences: AlertOccurrence[] }>("/v1/alerts/rules", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getWalletRequest(intentId: string) {
  return request<WalletTransactionRequest>(`/v1/actions/${encodeURIComponent(intentId)}/wallet-request`, {
    method: "POST",
  });
}

export function recordSubmission(intentId: string, txid: string) {
  return request<{ intentId: string; state: string; txid: string; reconciliation: string }>(
    `/v1/actions/${encodeURIComponent(intentId)}/submissions`,
    { method: "POST", body: JSON.stringify({ txid }) },
  );
}

export type AdminWindow = "24h" | "7d" | "30d";
export interface AdminOverview {
  window: AdminWindow;
  generatedAt: string;
  overallState: "live" | "degraded" | "broken";
  traffic: {
    requests: number;
    errors: number;
    errorRatePercent: number;
    averageLatencyMs: number;
    p95LatencyMs: number;
    addressSearches: number;
    uniqueAddresses: number;
    walletLogins: number;
  };
  workflows: {
    alertsCreated: number;
    reportsGenerated: number;
    apiKeysCreated: number;
    protectionPlans: number;
    activeWalletSessions: number;
    activeApiKeys: number;
    monthlyApiKeyRequests: number;
  };
  database: {
    state: "healthy";
    sizeBytes: number;
    activeConnections: number;
    transactionsCommitted: number;
    canonicalBlocks: number;
    canonicalTransactions: number;
    canonicalContractEvents: number;
    canonicalProjections: number;
    projectionIssues: number;
  };
  registry: { activeVersion: string | null; state: string; activatedAt: string | null };
  endpoints: Array<{
    route: string;
    requests: number;
    errors: number;
    averageLatencyMs: number;
    p95LatencyMs: number;
  }>;
  timeline: Array<{ hour: string; requests: number; errors: number; searches: number }>;
  backfills: Array<{
    contractPrincipal: string;
    status: string;
    nextOffset: number;
    observedTip: number | null;
    pagesCompleted: number;
    eventsSeen: number;
    transactionsIngested: number;
    lastError: string | null;
    updatedAt: string;
  }>;
  recentActivity: Array<{
    occurredAt: string;
    eventKind: string;
    route: string;
    method: string;
    statusCode: number;
    durationMs: number;
    actorKind: string;
  }>;
  api: {
    status: string;
    dataMode: string;
    network: string;
    registryMode: string;
    uptimeSeconds: number;
    startedAt: string;
    nodeVersion: string;
  };
  deployment: {
    provider: string;
    app: string | null;
    machineId: string | null;
    region: string | null;
    imageRef: string | null;
    releaseId: string | null;
  };
  chain: {
    canonicalTip: {
      network: string;
      indexBlockHash: string;
      height: number;
      canonical: boolean;
      burnBlockHeight: number | null;
    } | null;
    sources: Array<{
      sourceId: string;
      state: "green" | "amber" | "red";
      observedHeight: number | null;
      lagBlocks: number | null;
      detail: string | null;
    }>;
    chainhook: {
      uuid: string;
      state: string;
      enabled: boolean;
      occurrenceCount: number;
      lastBlock: number | null;
      lastEvaluatedAt: string | null;
      error: string | null;
    } | null;
  };
  modules: Array<{ name: string; state: "live" | "degraded" | "broken"; detail: string }>;
}

const ADMIN_SESSION_STORAGE_KEY = "riskosfolio:admin-session:v1";
let adminSessionToken = (() => {
  try {
    return browserSessionStorage()?.getItem(ADMIN_SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
})();

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "omit",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(adminSessionToken ? { authorization: `Bearer ${adminSessionToken}` } : {}),
      ...init?.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      adminSessionToken = null;
      browserSessionStorage()?.removeItem(ADMIN_SESSION_STORAGE_KEY);
    }
    throw new Error(
      typeof payload.detail === "string"
        ? payload.detail
        : typeof payload.title === "string"
          ? payload.title
          : "Admin request failed",
    );
  }
  return payload as T;
}

export function hasAdminSession(): boolean {
  return Boolean(adminSessionToken);
}

export async function createAdminSession(password: string) {
  const session = await adminRequest<{ token: string; expiresAt: string }>("/v1/admin/session", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  adminSessionToken = session.token;
  browserSessionStorage()?.setItem(ADMIN_SESSION_STORAGE_KEY, session.token);
  return session;
}

export function getAdminOverview(window: AdminWindow) {
  return adminRequest<AdminOverview>(`/v1/admin/overview?window=${window}`);
}

export async function logoutAdminSession(): Promise<void> {
  try {
    await fetch(`${API_URL}/v1/admin/logout`, {
      method: "POST",
      credentials: "omit",
      headers: adminSessionToken ? { authorization: `Bearer ${adminSessionToken}` } : {},
    });
  } finally {
    adminSessionToken = null;
    browserSessionStorage()?.removeItem(ADMIN_SESSION_STORAGE_KEY);
  }
}
