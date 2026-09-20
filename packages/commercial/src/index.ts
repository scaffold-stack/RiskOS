import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

export type CommercialPlanId = "free" | "pro" | "treasury" | "developer" | "protocol";
export type CommercialFeature =
  | "public-read"
  | "yield-explore"
  | "yield-recommend"
  | "history-extended"
  | "alerts-unlimited"
  | "reports"
  | "teams"
  | "api-access"
  | "priority-support";

export interface CommercialPlan {
  id: CommercialPlanId;
  name: string;
  audience: string;
  priceUsdMonthly: number | null;
  apiRequestsMonthly: number;
  maxAlertRules: number;
  maxWallets: number;
  features: CommercialFeature[];
  highlights: string[];
}

export const COMMERCIAL_PLANS: Readonly<Record<CommercialPlanId, CommercialPlan>> = {
  free: {
    id: "free",
    name: "Free",
    audience: "Public Bitcoin finance inspection",
    priceUsdMonthly: 0,
    apiRequestsMonthly: 1_000,
    maxAlertRules: 1,
    maxWallets: 1,
    features: ["public-read", "yield-explore", "api-access"],
    highlights: ["Current positions and risk", "Yield opportunity exploration", "One API key with 1,000 monthly requests"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    audience: "Active Bitcoin finance users",
    priceUsdMonthly: 29,
    apiRequestsMonthly: 10_000,
    maxAlertRules: 10,
    maxWallets: 1,
    features: ["public-read", "yield-explore", "yield-recommend", "history-extended", "alerts-unlimited", "reports", "api-access"],
    highlights: ["Up to ten alert policies", "Extended canonical history", "Evidence report and recommendation mode"],
  },
  treasury: {
    id: "treasury",
    name: "Treasury",
    audience: "Teams, DAOs, and professional operators",
    priceUsdMonthly: 299,
    apiRequestsMonthly: 50_000,
    maxAlertRules: 100,
    maxWallets: 1,
    features: ["public-read", "yield-explore", "yield-recommend", "history-extended", "alerts-unlimited", "reports", "api-access", "priority-support"],
    highlights: ["Up to one hundred alert policies", "Extended history and evidence reports", "Priority treasury support"],
  },
  developer: {
    id: "developer",
    name: "API Growth",
    audience: "Wallets and Bitcoin finance applications",
    priceUsdMonthly: 399,
    apiRequestsMonthly: 50_000,
    maxAlertRules: 0,
    maxWallets: 0,
    features: ["public-read", "yield-explore", "yield-recommend", "history-extended", "api-access"],
    highlights: ["50,000 metered API requests", "Typed SDK and embeddable widget", "Commercial integration rights"],
  },
  protocol: {
    id: "protocol",
    name: "Protocol Partner",
    audience: "Protocols requiring monitored integrations",
    priceUsdMonthly: null,
    apiRequestsMonthly: 1_000_000,
    maxAlertRules: 1_000,
    maxWallets: 1_000,
    features: ["public-read", "yield-explore", "yield-recommend", "history-extended", "alerts-unlimited", "reports", "teams", "api-access", "priority-support"],
    highlights: ["Custom adapter and evidence review", "Protocol-wide monitoring", "Incident support and negotiated SLA"],
  },
};

export interface ApiKeyRecord {
  keyId: string;
  keyPrefix: string;
  secretHash: string;
  ownerAddress: string | null;
  name: string;
  plan: CommercialPlanId;
  status: "active" | "revoked";
  monthlyRequestLimit: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CommercialEntitlement {
  subjectType: "wallet";
  subjectId: string;
  plan: "free" | "pro" | "treasury" | "developer" | "protocol";
  status: "active" | "expired" | "revoked";
  source: "manual" | "billing";
  startsAt: string;
  endsAt: string | null;
  updatedAt: string;
}

export interface ApiUsage {
  keyId: string;
  periodStart: string;
  requestCount: number;
  monthlyRequestLimit: number;
  remaining: number;
}

export type PublicApiKey = Omit<ApiKeyRecord, "secretHash">;

export interface CommercialStore {
  putApiKey(value: ApiKeyRecord): Promise<void>;
  apiKeyByHash(secretHash: string): Promise<ApiKeyRecord | null>;
  apiKeysForOwner(ownerAddress: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(keyId: string, at: Date, ownerAddress?: string): Promise<boolean>;
  consumeApiRequest(keyId: string, periodStart: string, at: Date): Promise<number>;
  apiUsage(keyId: string, periodStart: string): Promise<number>;
  putEntitlement(value: CommercialEntitlement): Promise<void>;
  entitlement(subjectType: "wallet", subjectId: string, at: Date): Promise<CommercialEntitlement | null>;
}

export class MemoryCommercialStore implements CommercialStore {
  private readonly keys = new Map<string, ApiKeyRecord>();
  private readonly usage = new Map<string, number>();
  private readonly entitlements = new Map<string, CommercialEntitlement>();

  async putApiKey(value: ApiKeyRecord) {
    this.keys.set(value.keyId, value);
  }

  async apiKeyByHash(secretHash: string) {
    return [...this.keys.values()].find((key) => key.secretHash === secretHash) ?? null;
  }

  async apiKeysForOwner(ownerAddress: string) {
    return [...this.keys.values()]
      .filter((key) => key.ownerAddress === ownerAddress)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async revokeApiKey(keyId: string, at: Date, ownerAddress?: string) {
    const existing = this.keys.get(keyId);
    if (!existing || existing.status === "revoked" || (ownerAddress !== undefined && existing.ownerAddress !== ownerAddress))
      return false;
    this.keys.set(keyId, { ...existing, status: "revoked", revokedAt: at.toISOString() });
    return true;
  }

  async consumeApiRequest(keyId: string, periodStart: string, at: Date) {
    const usageKey = `${keyId}:${periodStart}`;
    const next = (this.usage.get(usageKey) ?? 0) + 1;
    this.usage.set(usageKey, next);
    const key = this.keys.get(keyId);
    if (key) this.keys.set(keyId, { ...key, lastUsedAt: at.toISOString() });
    return next;
  }

  async apiUsage(keyId: string, periodStart: string) {
    return this.usage.get(`${keyId}:${periodStart}`) ?? 0;
  }

  async putEntitlement(value: CommercialEntitlement) {
    this.entitlements.set(`${value.subjectType}:${value.subjectId}`, value);
  }

  async entitlement(subjectType: "wallet", subjectId: string, at: Date) {
    const value = this.entitlements.get(`${subjectType}:${subjectId}`) ?? null;
    if (!value || value.status !== "active") return null;
    if (value.endsAt && Date.parse(value.endsAt) <= at.getTime()) return null;
    return value;
  }
}

export class PostgresCommercialStore implements CommercialStore {
  constructor(private readonly sql: Sql) {}

  async putApiKey(value: ApiKeyRecord) {
    await this.sql`INSERT INTO commercial_api_keys ${this.sql({
      key_id: value.keyId,
      key_prefix: value.keyPrefix,
      secret_hash: value.secretHash,
      owner_address: value.ownerAddress,
      name: value.name,
      plan: value.plan,
      status: value.status,
      monthly_request_limit: value.monthlyRequestLimit,
      created_at: value.createdAt,
      last_used_at: value.lastUsedAt,
      revoked_at: value.revokedAt,
    })}`;
  }

  async apiKeyByHash(secretHash: string) {
    const rows = await this.sql`SELECT * FROM commercial_api_keys WHERE secret_hash = ${secretHash}`;
    return rows[0] ? apiKeyRow(rows[0]) : null;
  }

  async apiKeysForOwner(ownerAddress: string) {
    const rows = await this.sql`
      SELECT * FROM commercial_api_keys
      WHERE owner_address = ${ownerAddress}
      ORDER BY created_at DESC
    `;
    return rows.map(apiKeyRow);
  }

  async revokeApiKey(keyId: string, at: Date, ownerAddress?: string) {
    const rows = await this.sql`
      UPDATE commercial_api_keys
      SET status = 'revoked', revoked_at = ${at}
      WHERE key_id = ${keyId} AND status = 'active'
        ${ownerAddress === undefined ? this.sql`` : this.sql`AND owner_address = ${ownerAddress}`}
      RETURNING key_id
    `;
    return rows.length === 1;
  }

  async consumeApiRequest(keyId: string, periodStart: string, at: Date) {
    const rows = await this.sql`
      INSERT INTO commercial_api_usage (key_id, period_start, request_count, updated_at)
      VALUES (${keyId}, ${periodStart}, 1, ${at})
      ON CONFLICT (key_id, period_start)
      DO UPDATE SET request_count = commercial_api_usage.request_count + 1, updated_at = EXCLUDED.updated_at
      RETURNING request_count
    `;
    await this.sql`UPDATE commercial_api_keys SET last_used_at = ${at} WHERE key_id = ${keyId}`;
    return Number(rows[0]?.request_count ?? 1);
  }

  async apiUsage(keyId: string, periodStart: string) {
    const rows = await this.sql`
      SELECT request_count FROM commercial_api_usage
      WHERE key_id = ${keyId} AND period_start = ${periodStart}
    `;
    return Number(rows[0]?.request_count ?? 0);
  }

  async putEntitlement(value: CommercialEntitlement) {
    await this.sql`
      INSERT INTO commercial_entitlements ${this.sql({
        subject_type: value.subjectType,
        subject_id: value.subjectId,
        plan: value.plan,
        status: value.status,
        source: value.source,
        starts_at: value.startsAt,
        ends_at: value.endsAt,
        updated_at: value.updatedAt,
      })}
      ON CONFLICT (subject_type, subject_id)
      DO UPDATE SET
        plan = EXCLUDED.plan,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async entitlement(subjectType: "wallet", subjectId: string, at: Date) {
    const rows = await this.sql`
      SELECT * FROM commercial_entitlements
      WHERE subject_type = ${subjectType}
        AND subject_id = ${subjectId}
        AND status = 'active'
        AND (ends_at IS NULL OR ends_at > ${at})
    `;
    return rows[0] ? entitlementRow(rows[0]) : null;
  }
}

export class CommercialService {
  constructor(
    private readonly store: CommercialStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  plans(): CommercialPlan[] {
    return Object.values(COMMERCIAL_PLANS);
  }

  async createApiKey(input: {
    name: string;
    plan: CommercialPlanId;
    monthlyRequestLimit?: number;
    ownerAddress?: string | null;
  }) {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new Error("API key name must be between 1 and 100 characters");
    const plan = COMMERCIAL_PLANS[input.plan];
    const monthlyRequestLimit = input.monthlyRequestLimit ?? plan.apiRequestsMonthly;
    if (!Number.isSafeInteger(monthlyRequestLimit) || monthlyRequestLimit < 1 || monthlyRequestLimit > 10_000_000)
      throw new Error("Monthly request limit must be between 1 and 10,000,000");
    const rawKey = `rko_${randomBytes(32).toString("base64url")}`;
    const at = this.now();
    const record: ApiKeyRecord = {
      keyId: `key_${randomUUID()}`,
      keyPrefix: rawKey.slice(0, 12),
      secretHash: commercialSecretHash(rawKey),
      ownerAddress: input.ownerAddress ?? null,
      name,
      plan: input.plan,
      status: "active",
      monthlyRequestLimit,
      createdAt: at.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.store.putApiKey(record);
    return { apiKey: rawKey, key: publicApiKey(record) };
  }

  async authenticateAndConsume(rawKey: string) {
    const key = await this.store.apiKeyByHash(commercialSecretHash(rawKey));
    if (!key || key.status !== "active") return { state: "invalid" as const };
    const at = this.now();
    const periodStart = commercialPeriodStart(at);
    const requestCount = await this.store.consumeApiRequest(key.keyId, periodStart, at);
    const usage = usageView(key, periodStart, requestCount);
    if (requestCount > key.monthlyRequestLimit) return { state: "exhausted" as const, key: publicApiKey(key), usage };
    return { state: "authenticated" as const, key: publicApiKey(key), usage };
  }

  async usageForKey(key: ApiKeyRecord | PublicApiKey): Promise<ApiUsage> {
    const periodStart = commercialPeriodStart(this.now());
    const requestCount = await this.store.apiUsage(key.keyId, periodStart);
    return usageView(key, periodStart, requestCount);
  }

  async revokeApiKey(keyId: string): Promise<boolean> {
    return this.store.revokeApiKey(keyId, this.now());
  }

  async walletApiKeys(address: string) {
    const keys = await this.store.apiKeysForOwner(address);
    return Promise.all(keys.map(async (key) => ({ key: publicApiKey(key), usage: await this.usageForKey(key) })));
  }

  async createWalletApiKey(address: string, name: string) {
    const { plan } = await this.walletPlan(address);
    const keys = await this.store.apiKeysForOwner(address);
    if (keys.filter((key) => key.status === "active").length >= apiKeyLimitForPlan(plan.id))
      throw new Error("API_KEY_LIMIT_REACHED");
    return this.createApiKey({
      name,
      plan: plan.id,
      monthlyRequestLimit: plan.apiRequestsMonthly,
      ownerAddress: address,
    });
  }

  async revokeWalletApiKey(address: string, keyId: string): Promise<boolean> {
    return this.store.revokeApiKey(keyId, this.now(), address);
  }

  async grantWalletPlan(input: {
    address: string;
    plan: "free" | "pro" | "treasury" | "developer" | "protocol";
    endsAt?: string | null;
    source?: "manual" | "billing";
  }): Promise<CommercialEntitlement> {
    const at = this.now();
    const endsAt = input.endsAt ?? null;
    if (endsAt && (!Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= at.getTime()))
      throw new Error("Entitlement end must be a future ISO timestamp");
    const entitlement: CommercialEntitlement = {
      subjectType: "wallet",
      subjectId: input.address,
      plan: input.plan,
      status: "active",
      source: input.source ?? "manual",
      startsAt: at.toISOString(),
      endsAt,
      updatedAt: at.toISOString(),
    };
    await this.store.putEntitlement(entitlement);
    return entitlement;
  }

  async walletPlan(address: string) {
    const entitlement = await this.store.entitlement("wallet", address, this.now());
    const plan = COMMERCIAL_PLANS[entitlement?.plan ?? "free"];
    return { entitlement, plan };
  }
}

export function commercialSecretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function commercialPeriodStart(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function hasCommercialFeature(plan: CommercialPlan, feature: CommercialFeature): boolean {
  return plan.features.includes(feature);
}

export function apiKeyLimitForPlan(plan: CommercialPlanId): number {
  return plan === "developer" || plan === "protocol" ? 5 : 1;
}

function publicApiKey(key: ApiKeyRecord): PublicApiKey {
  return {
    keyId: key.keyId,
    keyPrefix: key.keyPrefix,
    ownerAddress: key.ownerAddress,
    name: key.name,
    plan: key.plan,
    status: key.status,
    monthlyRequestLimit: key.monthlyRequestLimit,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  };
}

function usageView(
  key: Pick<ApiKeyRecord, "keyId" | "monthlyRequestLimit">,
  periodStart: string,
  requestCount: number,
): ApiUsage {
  return {
    keyId: key.keyId,
    periodStart,
    requestCount,
    monthlyRequestLimit: key.monthlyRequestLimit,
    remaining: Math.max(0, key.monthlyRequestLimit - requestCount),
  };
}

function apiKeyRow(row: postgres.Row): ApiKeyRecord {
  return {
    keyId: String(row.key_id),
    keyPrefix: String(row.key_prefix),
    secretHash: String(row.secret_hash),
    ownerAddress: row.owner_address ? String(row.owner_address) : null,
    name: String(row.name),
    plan: String(row.plan) as ApiKeyRecord["plan"],
    status: String(row.status) as ApiKeyRecord["status"],
    monthlyRequestLimit: Number(row.monthly_request_limit),
    createdAt: new Date(String(row.created_at)).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
  };
}

function entitlementRow(row: postgres.Row): CommercialEntitlement {
  return {
    subjectType: "wallet",
    subjectId: String(row.subject_id),
    plan: String(row.plan) as CommercialEntitlement["plan"],
    status: String(row.status) as CommercialEntitlement["status"],
    source: String(row.source) as CommercialEntitlement["source"],
    startsAt: new Date(String(row.starts_at)).toISOString(),
    endsAt: row.ends_at ? new Date(String(row.ends_at)).toISOString() : null,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}
