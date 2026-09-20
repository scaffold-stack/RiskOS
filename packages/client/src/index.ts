import type {
  AccountPlanResponse,
  AlertOccurrence,
  AlertRule,
  DeveloperUsageResponse,
  HealthResponse,
  PortfolioHistory,
  PortfolioSummary,
  PositionEnvelope,
  PlansResponse,
  PortfolioEvidenceReport,
  RiskCategory,
  RiskFinding,
  RiskSeverity,
  SbtcOperation,
  TransactionIntent,
  WalletChallenge,
  WalletSession,
  WalletTransactionRequest,
  YieldAllocationPlan,
  YieldMarket,
} from "./types.js";

export const RISKOS_SDK_VERSION = "0.2.0";

export interface RiskOsClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  apiKey?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  headers?: Readonly<Record<string, string>>;
}

export interface RiskOsRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
}

export class RiskOsClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RiskOsClientError";
  }
}

export class RiskOsClient {
  private readonly request: typeof fetch;
  private readonly credentials: RequestCredentials;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: RiskOsClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new TypeError("RiskOsClient baseUrl must use http or https");
    if (parsed.username || parsed.password)
      throw new TypeError("RiskOsClient baseUrl must not contain credentials");
    if (options.apiKey !== undefined && options.apiKey.trim().length < 16)
      throw new TypeError("RiskOsClient apiKey must be at least 16 characters");
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.request = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.credentials = options.credentials ?? "omit";
    this.apiKey = options.apiKey?.trim();
    this.timeoutMs = positiveInteger(options.timeoutMs, 15_000, "timeoutMs");
    this.retries = nonnegativeInteger(options.retries, 2, "retries");
    this.retryDelayMs = positiveInteger(options.retryDelayMs, 250, "retryDelayMs");
    this.headers = options.headers ?? {};
  }

  health(options?: RiskOsRequestOptions) {
    return this.get<HealthResponse>("/health", options);
  }

  getDemoAddress(options?: RiskOsRequestOptions) {
    return this.get<{ address: string }>("/v1/demo", options);
  }

  getPlans(options?: RiskOsRequestOptions) {
    return this.get<PlansResponse>("/v1/plans", options);
  }

  getDeveloperUsage(options?: RiskOsRequestOptions) {
    return this.get<DeveloperUsageResponse>("/v1/developer/usage", options);
  }

  getAccountPlan(options?: RiskOsRequestOptions) {
    return this.get<AccountPlanResponse>("/v1/account/plan", options);
  }

  getPositions(address: string, options?: RiskOsRequestOptions) {
    return this.get<PositionEnvelope>(addressPath(address, "positions"), options);
  }

  getRisk(address: string, options?: RiskOsRequestOptions) {
    return this.get<{ address: string; asOf: PositionEnvelope["asOf"]; risks: RiskFinding[]; warnings: string[] }>(
      addressPath(address, "risk"),
      options,
    );
  }

  getPortfolio(address: string, options?: RiskOsRequestOptions) {
    return this.get<PortfolioSummary>(addressPath(address, "portfolio"), options);
  }

  getOverview(address: string, options?: RiskOsRequestOptions) {
    return this.get<{
      address: string;
      positions: PositionEnvelope;
      risks: RiskFinding[];
      portfolio: PortfolioSummary;
    }>(addressPath(address, "overview"), options);
  }

  getHistory(address: string, input: { limit?: number } = {}, options?: RiskOsRequestOptions) {
    const limit = input.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new RangeError("history limit must be an integer between 1 and 1000");
    return this.get<PortfolioHistory>(`${addressPath(address, "history")}?limit=${limit}`, options);
  }

  getSbtcOperations(address: string, options?: RiskOsRequestOptions) {
    return this.get<{ address: string; operations: SbtcOperation[] }>(
      addressPath(address, "sbtc-operations"),
      options,
    );
  }

  getYieldMarkets(options?: RiskOsRequestOptions) {
    return this.get<{ asOf: string; markets: YieldMarket[] }>("/v1/yield/markets", options);
  }

  createYieldAllocation(
    input: { capitalUsd: string; days: 30 | 90 | 365; mode?: "explore" | "recommend" },
    options?: RiskOsRequestOptions,
  ) {
    return this.post<YieldAllocationPlan>(
      "/v1/yield/allocations",
      { ...input, mode: input.mode ?? "explore" },
      options,
    );
  }

  createWalletChallenge(address: string, options?: RiskOsRequestOptions) {
    return this.post<WalletChallenge>("/v1/auth/challenge", { address }, options);
  }

  verifyWalletChallenge(
    input: { challengeId: string; address: string; publicKey: string; signature: string },
    options?: RiskOsRequestOptions,
  ) {
    return this.post<WalletSession>("/v1/auth/verify", input, options);
  }

  getWalletSession(options?: RiskOsRequestOptions) {
    return this.get<WalletSession>("/v1/auth/session", options);
  }

  async logoutWalletSession(options?: RiskOsRequestOptions): Promise<void> {
    await this.send<void>("/v1/auth/logout", { method: "POST" }, options);
  }

  getAlerts(options?: RiskOsRequestOptions) {
    return this.get<{ address: string; rules: AlertRule[]; occurrences: AlertOccurrence[] }>(
      "/v1/alerts",
      options,
    );
  }

  getPortfolioEvidenceReport(options?: RiskOsRequestOptions) {
    return this.get<PortfolioEvidenceReport>("/v1/reports/portfolio", options);
  }

  createAlertRule(
    input: { name: string; categories: RiskCategory[]; minimumSeverity: RiskSeverity },
    options?: RiskOsRequestOptions,
  ) {
    return this.post<{ rule: AlertRule; occurrences: AlertOccurrence[] }>("/v1/alerts/rules", input, options);
  }

  /**
   * Protective planning remains advisory on mainnet (shadow intents, no broadcast).
   */
  planRepay(address: string, positionId: string, amountAtomic: string, options?: RiskOsRequestOptions) {
    return this.post<TransactionIntent>(
      "/v1/actions/plan",
      { address, positionId, action: "repay", amountAtomic },
      options,
    );
  }

  /** Requires an authenticated wallet session; the server recalculates before persisting. */
  saveRepayIntent(address: string, positionId: string, amountAtomic: string, options?: RiskOsRequestOptions) {
    return this.post<TransactionIntent>(
      "/v1/actions/intents",
      { address, positionId, action: "repay", amountAtomic },
      options,
    );
  }

  getWalletRequest(intentId: string, options?: RiskOsRequestOptions) {
    return this.post<WalletTransactionRequest>(
      `/v1/actions/${encodeURIComponent(requiredString(intentId, "intentId"))}/wallet-request`,
      undefined,
      options,
    );
  }

  recordSubmission(intentId: string, txid: string, options?: RiskOsRequestOptions) {
    return this.post<{ intentId: string; state: string; txid: string; reconciliation: string }>(
      `/v1/actions/${encodeURIComponent(requiredString(intentId, "intentId"))}/submissions`,
      { txid },
      options,
    );
  }

  private get<T>(path: string, options?: RiskOsRequestOptions): Promise<T> {
    return this.send<T>(path, undefined, options);
  }

  private post<T>(path: string, body: unknown, options?: RiskOsRequestOptions): Promise<T> {
    return this.send<T>(
      path,
      body === undefined
        ? { method: "POST" }
        : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
      options,
    );
  }

  private async send<T>(
    path: string,
    init: RequestInit = {},
    options: RiskOsRequestOptions = {},
  ): Promise<T> {
    const attempts = (options.retries ?? this.retries) + 1;
    const canRetry = (init.method ?? "GET").toUpperCase() === "GET";
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const timeout = timeoutSignal(options.signal, options.timeoutMs ?? this.timeoutMs);
      try {
        const response = await this.request(`${this.baseUrl}${path}`, {
          ...init,
          credentials: this.credentials,
          signal: timeout.signal,
          headers: {
            accept: "application/json",
            "x-riskos-sdk-version": RISKOS_SDK_VERSION,
            ...this.headers,
            ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
            ...init.headers,
          },
        });
        const payload = await responsePayload(response);
        if (response.ok) return payload as T;
        const error = responseError(response, payload);
        if (!canRetry || attempt + 1 >= attempts || !retryableStatus(response.status)) throw error;
        lastError = error;
        await delay(retryDelay(response, attempt, this.retryDelayMs), options.signal);
      } catch (error) {
        if (error instanceof RiskOsClientError) throw error;
        if (options.signal?.aborted)
          throw new RiskOsClientError(0, "REQUEST_ABORTED", "Request aborted", undefined, undefined, undefined, {
            cause: error,
          });
        lastError = error;
        if (!canRetry || attempt + 1 >= attempts) {
          const timedOut = timeout.signal.aborted;
          throw new RiskOsClientError(
            0,
            timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
            timedOut ? "Request timed out" : "Network request failed",
            error instanceof Error ? error.message : undefined,
            undefined,
            undefined,
            { cause: error },
          );
        }
        await delay(this.retryDelayMs * 2 ** attempt, options.signal);
      } finally {
        timeout.cleanup();
      }
    }
    throw lastError;
  }
}

function addressPath(address: string, resource: string): string {
  return `/v1/address/${encodeURIComponent(requiredString(address, "address"))}/${resource}`;
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new RangeError(`${label} must be a positive integer`);
  return resolved;
}

function nonnegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0)
    throw new RangeError(`${label} must be a non-negative integer`);
  return resolved;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Request exceeded ${timeoutMs}ms`)), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RiskOsClientError(
      response.status,
      "INVALID_RESPONSE",
      "RiskOS returned invalid JSON",
      undefined,
      response.headers.get("x-request-id") ?? undefined,
      undefined,
      { cause },
    );
  }
}

function responseError(response: Response, payload: unknown): RiskOsClientError {
  const body = isRecord(payload) ? payload : {};
  return new RiskOsClientError(
    response.status,
    typeof body.code === "string" ? body.code : "REQUEST_FAILED",
    typeof body.title === "string" ? body.title : `Request failed with status ${response.status}`,
    typeof body.detail === "string" ? body.detail : typeof payload === "string" ? payload : undefined,
    response.headers.get("x-request-id") ?? undefined,
    retryAfterSeconds(response.headers.get("retry-after")),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}

function retryDelay(response: Response, attempt: number, fallbackMs: number): number {
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  return retryAfter === undefined ? fallbackMs * 2 ** attempt : Math.min(retryAfter * 1_000, 30_000);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type * from "./types.js";
