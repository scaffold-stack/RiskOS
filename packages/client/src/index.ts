import type {
  PortfolioSummary,
  PositionEnvelope,
  RiskFinding,
  TransactionIntent,
} from "../../domain/src/index.js";

export interface RiskOsClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
}

export class RiskOsClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "RiskOsClientError";
  }
}

export class RiskOsClient {
  private readonly request: typeof fetch;
  private readonly credentials: RequestCredentials;

  constructor(private readonly options: RiskOsClientOptions) {
    this.request = options.fetch ?? fetch;
    this.credentials = options.credentials ?? "omit";
  }

  async health() {
    return this.get<{
      status: string;
      dataMode: string;
      network?: string;
      registryMode?: string;
      execution: string;
      pricing?: string;
      modules?: Record<string, string>;
    }>("/health");
  }

  getPositions(address: string) {
    return this.get<PositionEnvelope>(`/v1/address/${encodeURIComponent(address)}/positions`);
  }

  getRisk(address: string) {
    return this.get<{ address: string; asOf: PositionEnvelope["asOf"]; risks: RiskFinding[]; warnings: string[] }>(
      `/v1/address/${encodeURIComponent(address)}/risk`,
    );
  }

  getPortfolio(address: string) {
    return this.get<PortfolioSummary>(`/v1/address/${encodeURIComponent(address)}/portfolio`);
  }

  /**
   * Protective planning remains advisory on mainnet (shadow intents, no broadcast).
   */
  planRepay(address: string, positionId: string, amountAtomic: string) {
    return this.post<TransactionIntent>("/v1/actions/plan", { address, positionId, action: "repay", amountAtomic });
  }

  /** Requires an authenticated wallet session; the server recalculates before persisting. */
  saveRepayIntent(address: string, positionId: string, amountAtomic: string) {
    return this.post<TransactionIntent>("/v1/actions/intents", { address, positionId, action: "repay", amountAtomic });
  }

  private async get<T>(path: string): Promise<T> {
    return this.send<T>(path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  }

  private async send<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      credentials: this.credentials,
      headers: { accept: "application/json", ...init?.headers },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new RiskOsClientError(
        response.status,
        typeof payload.code === "string" ? payload.code : "REQUEST_FAILED",
        typeof payload.title === "string" ? payload.title : "Request failed",
        typeof payload.detail === "string" ? payload.detail : undefined,
      );
    }
    return payload as T;
  }
}

export type { PortfolioSummary, PositionEnvelope, RiskFinding, TransactionIntent };
