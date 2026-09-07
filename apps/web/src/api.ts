import type { AlertOccurrence, AlertRule, PortfolioSummary, PositionEnvelope, RiskFinding, TransactionIntent, WalletChallenge, WalletSessionView, WalletTransactionRequest } from "../../../packages/domain/src/index.js";

const API_URL = import.meta.env.VITE_API_URL ?? `${window.location.protocol}//${window.location.hostname}:3001`;

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail ?? payload.title ?? "Request failed");
  return payload as T;
}

export function createWalletChallenge(address: string) {
  return request<WalletChallenge>("/v1/auth/challenge", { method: "POST", body: JSON.stringify({ address }) });
}

export function verifyWalletChallenge(input: { challengeId: string; address: string; publicKey: string; signature: string }) {
  return request<WalletSessionView>("/v1/auth/verify", { method: "POST", body: JSON.stringify(input) });
}

export function getWalletSession() { return request<WalletSessionView>("/v1/auth/session"); }
export async function logoutWalletSession() {
  const response = await fetch(`${API_URL}/v1/auth/logout`, { method: "POST", credentials: "include" });
  if (!response.ok) throw new Error("Unable to close the wallet session");
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

export function getPositions(address: string) {
  return request<PositionEnvelope>(`/v1/address/${encodeURIComponent(address)}/positions`);
}

export function getRisks(address: string) {
  return request<{ risks: RiskFinding[] }>(`/v1/address/${encodeURIComponent(address)}/risk`);
}

export function getPortfolioSummary(address: string) {
  return request<PortfolioSummary>(`/v1/address/${encodeURIComponent(address)}/portfolio`);
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

export interface AlertsResponse { address: string; rules: AlertRule[]; occurrences: AlertOccurrence[]; }
export function getAlerts() { return request<AlertsResponse>("/v1/alerts"); }
export function createAlertRule(input: { name: string; categories: RiskFinding["category"][]; minimumSeverity: RiskFinding["severity"] }) {
  return request<{ rule: AlertRule; occurrences: AlertOccurrence[] }>("/v1/alerts/rules", { method: "POST", body: JSON.stringify(input) });
}

export function getWalletRequest(intentId: string) {
  return request<WalletTransactionRequest>(`/v1/actions/${encodeURIComponent(intentId)}/wallet-request`, { method: "POST" });
}

export function recordSubmission(intentId: string, txid: string) {
  return request<{ intentId: string; state: string; txid: string; reconciliation: string }>(`/v1/actions/${encodeURIComponent(intentId)}/submissions`, { method: "POST", body: JSON.stringify({ txid }) });
}
