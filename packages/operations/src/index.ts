import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export type AnalyticsWindow = "24h" | "7d" | "30d";
export type AnalyticsActor =
  | "anonymous"
  | "wallet"
  | "api-key"
  | "admin"
  | "chainhook"
  | "operations";
export type AnalyticsEventKind =
  | "api-request"
  | "address-search"
  | "wallet-login"
  | "alert-created"
  | "api-key-created"
  | "report-generated"
  | "protection-planned"
  | "chainhook-delivery"
  | "admin-login";

export interface RequestAnalyticsEvent {
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  actorKind: AnalyticsActor;
  apiKeyId: string | null;
  addressHash: string | null;
  eventKind: AnalyticsEventKind;
  occurredAt: string;
}

export interface AdminAnalyticsSnapshot {
  window: AnalyticsWindow;
  generatedAt: string;
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
  registry: {
    activeVersion: string | null;
    state: string;
    activatedAt: string | null;
  };
  endpoints: Array<{
    route: string;
    requests: number;
    errors: number;
    averageLatencyMs: number;
    p95LatencyMs: number;
  }>;
  timeline: Array<{
    hour: string;
    requests: number;
    errors: number;
    searches: number;
  }>;
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
    eventKind: AnalyticsEventKind;
    route: string;
    method: string;
    statusCode: number;
    durationMs: number;
    actorKind: AnalyticsActor;
  }>;
}

export interface AdminAnalyticsStore {
  recordRequest(event: RequestAnalyticsEvent): Promise<void>;
  snapshot(window: AnalyticsWindow, now: Date): Promise<AdminAnalyticsSnapshot>;
}

function windowStart(window: AnalyticsWindow, now: Date): Date {
  const milliseconds =
    window === "24h" ? 24 * 60 * 60 * 1_000 : window === "7d" ? 7 * 24 * 60 * 60 * 1_000 : 30 * 24 * 60 * 60 * 1_000;
  return new Date(now.getTime() - milliseconds);
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

export class MemoryAdminAnalyticsStore implements AdminAnalyticsStore {
  readonly events: RequestAnalyticsEvent[] = [];

  async recordRequest(event: RequestAnalyticsEvent): Promise<void> {
    this.events.push(event);
  }

  async snapshot(window: AnalyticsWindow, now: Date): Promise<AdminAnalyticsSnapshot> {
    const since = windowStart(window, now).getTime();
    const events = this.events.filter((event) => Date.parse(event.occurredAt) >= since);
    const durations = events.map((event) => event.durationMs).sort((a, b) => a - b);
    const errors = events.filter((event) => event.statusCode >= 400).length;
    const eventCount = (kind: AnalyticsEventKind) =>
      events.filter((event) => event.eventKind === kind).length;
    const endpointMap = new Map<string, RequestAnalyticsEvent[]>();
    for (const event of events)
      endpointMap.set(event.route, [...(endpointMap.get(event.route) ?? []), event]);
    return {
      window,
      generatedAt: now.toISOString(),
      traffic: {
        requests: events.length,
        errors,
        errorRatePercent: events.length ? (errors / events.length) * 100 : 0,
        averageLatencyMs: events.length
          ? events.reduce((total, event) => total + event.durationMs, 0) / events.length
          : 0,
        p95LatencyMs: durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0,
        addressSearches: eventCount("address-search"),
        uniqueAddresses: new Set(
          events.filter((event) => event.eventKind === "address-search").map((event) => event.addressHash),
        ).size,
        walletLogins: eventCount("wallet-login"),
      },
      workflows: {
        alertsCreated: eventCount("alert-created"),
        reportsGenerated: eventCount("report-generated"),
        apiKeysCreated: eventCount("api-key-created"),
        protectionPlans: eventCount("protection-planned"),
        activeWalletSessions: 0,
        activeApiKeys: 0,
        monthlyApiKeyRequests: 0,
      },
      database: {
        state: "healthy",
        sizeBytes: 0,
        activeConnections: 0,
        transactionsCommitted: 0,
        canonicalBlocks: 0,
        canonicalTransactions: 0,
        canonicalContractEvents: 0,
        canonicalProjections: 0,
        projectionIssues: 0,
      },
      registry: { activeVersion: null, state: "none", activatedAt: null },
      endpoints: [...endpointMap.entries()].map(([route, routeEvents]) => {
        const routeDurations = routeEvents.map((event) => event.durationMs).sort((a, b) => a - b);
        return {
          route,
          requests: routeEvents.length,
          errors: routeEvents.filter((event) => event.statusCode >= 400).length,
          averageLatencyMs:
            routeEvents.reduce((total, event) => total + event.durationMs, 0) / routeEvents.length,
          p95LatencyMs:
            routeDurations[Math.max(0, Math.ceil(routeDurations.length * 0.95) - 1)] ?? 0,
        };
      }),
      timeline: [],
      backfills: [],
      recentActivity: events.slice(-50).reverse().map((event) => ({
        occurredAt: event.occurredAt,
        eventKind: event.eventKind,
        route: event.route,
        method: event.method,
        statusCode: event.statusCode,
        durationMs: event.durationMs,
        actorKind: event.actorKind,
      })),
    };
  }
}

export class PostgresAdminAnalyticsStore implements AdminAnalyticsStore {
  constructor(private readonly sql: Sql) {}

  async recordRequest(event: RequestAnalyticsEvent): Promise<void> {
    await this.sql`
      INSERT INTO platform_request_events ${this.sql({
        request_id: event.requestId,
        method: event.method,
        route: event.route,
        status_code: event.statusCode,
        duration_ms: event.durationMs,
        actor_kind: event.actorKind,
        api_key_id: event.apiKeyId,
        address_hash: event.addressHash,
        event_kind: event.eventKind,
        occurred_at: event.occurredAt,
      })}
    `;
  }

  async snapshot(window: AnalyticsWindow, now: Date): Promise<AdminAnalyticsSnapshot> {
    const since = windowStart(window, now);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [
      trafficRows,
      workflowRows,
      databaseRows,
      canonicalRows,
      registryRows,
      endpointRows,
      timelineRows,
      backfillRows,
      recentRows,
    ] = await Promise.all([
      this.sql`
        SELECT
          count(*)::bigint AS requests,
          count(*) FILTER (WHERE status_code >= 400)::bigint AS errors,
          coalesce(avg(duration_ms), 0) AS average_latency_ms,
          coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0) AS p95_latency_ms,
          count(*) FILTER (WHERE event_kind = 'address-search')::bigint AS address_searches,
          count(DISTINCT address_hash) FILTER (WHERE event_kind = 'address-search')::bigint AS unique_addresses,
          count(*) FILTER (WHERE event_kind = 'wallet-login')::bigint AS wallet_logins
        FROM platform_request_events
        WHERE occurred_at >= ${since}
      `,
      this.sql`
        SELECT
          (SELECT count(*) FROM platform_request_events WHERE occurred_at >= ${since} AND event_kind = 'alert-created') AS alerts_created,
          (SELECT count(*) FROM platform_request_events WHERE occurred_at >= ${since} AND event_kind = 'report-generated') AS reports_generated,
          (SELECT count(*) FROM platform_request_events WHERE occurred_at >= ${since} AND event_kind = 'api-key-created') AS api_keys_created,
          (SELECT count(*) FROM platform_request_events WHERE occurred_at >= ${since} AND event_kind = 'protection-planned') AS protection_plans,
          (SELECT count(DISTINCT address) FROM wallet_sessions WHERE expires_at > ${now}) AS active_wallet_sessions,
          (SELECT count(*) FROM commercial_api_keys WHERE status = 'active') AS active_api_keys,
          (SELECT coalesce(sum(request_count), 0) FROM commercial_api_usage WHERE period_start >= ${monthStart}) AS monthly_api_key_requests
      `,
      this.sql`
        SELECT
          pg_database_size(current_database()) AS size_bytes,
          numbackends AS active_connections,
          xact_commit AS transactions_committed
        FROM pg_stat_database
        WHERE datname = current_database()
      `,
      this.sql`
        SELECT
          (SELECT count(*) FROM chain_blocks WHERE canonical) AS canonical_blocks,
          (SELECT count(*) FROM chain_transactions WHERE canonical) AS canonical_transactions,
          (SELECT count(*) FROM contract_events WHERE canonical) AS canonical_contract_events,
          (SELECT count(*) FROM protocol_projection_events WHERE canonical) AS canonical_projections,
          (SELECT count(*) FROM projection_issues WHERE canonical) AS projection_issues
      `,
      this.sql`
        SELECT version, state, activated_at
        FROM registry_versions
        WHERE state = 'active'
        ORDER BY activated_at DESC NULLS LAST
        LIMIT 1
      `,
      this.sql`
        SELECT
          route,
          count(*)::bigint AS requests,
          count(*) FILTER (WHERE status_code >= 400)::bigint AS errors,
          coalesce(avg(duration_ms), 0) AS average_latency_ms,
          coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0) AS p95_latency_ms
        FROM platform_request_events
        WHERE occurred_at >= ${since}
        GROUP BY route
        ORDER BY requests DESC
        LIMIT 20
      `,
      this.sql`
        SELECT
          date_trunc('hour', occurred_at) AS hour,
          count(*)::bigint AS requests,
          count(*) FILTER (WHERE status_code >= 400)::bigint AS errors,
          count(*) FILTER (WHERE event_kind = 'address-search')::bigint AS searches
        FROM platform_request_events
        WHERE occurred_at >= ${since}
        GROUP BY 1
        ORDER BY 1
      `,
      this.sql`
        SELECT contract_principal, status, next_offset, observed_tip, pages_completed,
          events_seen, transactions_ingested, last_error, updated_at
        FROM registry_backfill_checkpoints
        WHERE network = 'mainnet'
        ORDER BY updated_at DESC
      `,
      this.sql`
        SELECT occurred_at, event_kind, route, method, status_code, duration_ms, actor_kind
        FROM platform_request_events
        WHERE occurred_at >= ${since}
        ORDER BY occurred_at DESC
        LIMIT 50
      `,
    ]);
    const traffic = trafficRows[0] ?? {};
    const workflows = workflowRows[0] ?? {};
    const database = databaseRows[0] ?? {};
    const canonical = canonicalRows[0] ?? {};
    const requestCount = number(traffic.requests);
    const errorCount = number(traffic.errors);
    const registry = registryRows[0];
    return {
      window,
      generatedAt: now.toISOString(),
      traffic: {
        requests: requestCount,
        errors: errorCount,
        errorRatePercent: requestCount ? (errorCount / requestCount) * 100 : 0,
        averageLatencyMs: number(traffic.average_latency_ms),
        p95LatencyMs: number(traffic.p95_latency_ms),
        addressSearches: number(traffic.address_searches),
        uniqueAddresses: number(traffic.unique_addresses),
        walletLogins: number(traffic.wallet_logins),
      },
      workflows: {
        alertsCreated: number(workflows.alerts_created),
        reportsGenerated: number(workflows.reports_generated),
        apiKeysCreated: number(workflows.api_keys_created),
        protectionPlans: number(workflows.protection_plans),
        activeWalletSessions: number(workflows.active_wallet_sessions),
        activeApiKeys: number(workflows.active_api_keys),
        monthlyApiKeyRequests: number(workflows.monthly_api_key_requests),
      },
      database: {
        state: "healthy",
        sizeBytes: number(database.size_bytes),
        activeConnections: number(database.active_connections),
        transactionsCommitted: number(database.transactions_committed),
        canonicalBlocks: number(canonical.canonical_blocks),
        canonicalTransactions: number(canonical.canonical_transactions),
        canonicalContractEvents: number(canonical.canonical_contract_events),
        canonicalProjections: number(canonical.canonical_projections),
        projectionIssues: number(canonical.projection_issues),
      },
      registry: {
        activeVersion: registry ? String(registry.version) : null,
        state: registry ? String(registry.state) : "none",
        activatedAt: registry?.activated_at ? iso(registry.activated_at) : null,
      },
      endpoints: endpointRows.map((row) => ({
        route: String(row.route),
        requests: number(row.requests),
        errors: number(row.errors),
        averageLatencyMs: number(row.average_latency_ms),
        p95LatencyMs: number(row.p95_latency_ms),
      })),
      timeline: timelineRows.map((row) => ({
        hour: iso(row.hour),
        requests: number(row.requests),
        errors: number(row.errors),
        searches: number(row.searches),
      })),
      backfills: backfillRows.map((row) => ({
        contractPrincipal: String(row.contract_principal),
        status: String(row.status),
        nextOffset: number(row.next_offset),
        observedTip: row.observed_tip === null ? null : number(row.observed_tip),
        pagesCompleted: number(row.pages_completed),
        eventsSeen: number(row.events_seen),
        transactionsIngested: number(row.transactions_ingested),
        lastError: row.last_error === null ? null : String(row.last_error),
        updatedAt: iso(row.updated_at),
      })),
      recentActivity: recentRows.map((row) => ({
        occurredAt: iso(row.occurred_at),
        eventKind: String(row.event_kind) as AnalyticsEventKind,
        route: String(row.route),
        method: String(row.method),
        statusCode: number(row.status_code),
        durationMs: number(row.duration_ms),
        actorKind: String(row.actor_kind) as AnalyticsActor,
      })),
    };
  }
}

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 32;

function derivePassword(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, { ...options, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function createAdminPasswordVerifier(password: string): Promise<string> {
  if (password.length < 12) throw new Error("Admin password must contain at least 12 characters");
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, SCRYPT_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyAdminPassword(password: string, verifier: string): Promise<boolean> {
  const [algorithm, rawN, rawR, rawP, rawSalt, rawHash] = verifier.split("$");
  if (
    algorithm !== "scrypt" ||
    !rawN ||
    !rawR ||
    !rawP ||
    !rawSalt ||
    !rawHash
  )
    return false;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  const expected = Buffer.from(rawHash, "base64url");
  if (expected.length !== SCRYPT_LENGTH) return false;
  const actual = await derivePassword(password, Buffer.from(rawSalt, "base64url"), expected.length, {
    N,
    r,
    p,
  });
  return timingSafeEqual(actual, expected);
}

export interface AdminSession {
  token: string;
  expiresAt: string;
}

export class AdminSessionService {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly passwordVerifier: string,
    private readonly ttlMilliseconds = 8 * 60 * 60 * 1_000,
  ) {}

  async login(password: string, now: Date): Promise<AdminSession | null> {
    if (!(await verifyAdminPassword(password, this.passwordVerifier))) return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now.getTime() + this.ttlMilliseconds;
    this.sessions.set(createHash("sha256").update(token).digest("hex"), expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  authenticate(token: string | null, now: Date): boolean {
    if (!token) return false;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = this.sessions.get(tokenHash);
    if (!expiresAt || expiresAt <= now.getTime()) {
      this.sessions.delete(tokenHash);
      return false;
    }
    return true;
  }

  logout(token: string | null): void {
    if (token) this.sessions.delete(createHash("sha256").update(token).digest("hex"));
  }
}
