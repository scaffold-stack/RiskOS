import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import type {
  AlertOccurrence,
  AlertRule,
  AlertSeverity,
  RiskFinding,
  TransactionIntent,
} from "../../domain/src/index.js";

type Network = "mainnet" | "testnet";
type Sql = ReturnType<typeof postgres>;

export interface StoredWalletChallenge {
  challengeId: string;
  address: string;
  network: Network;
  message: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface StoredSession {
  tokenHash: string;
  address: string;
  network: Network;
  expiresAt: string;
}

export interface StoredIntent {
  intent: TransactionIntent;
  address: string;
  intentHash: string;
  state: "planned" | "wallet-requested" | "submitted" | "confirmed" | "blocked";
  txid: string | null;
  updatedAt: string;
}

export interface ProductStore {
  putChallenge(challenge: StoredWalletChallenge): Promise<void>;
  consumeChallenge(challengeId: string, at: Date): Promise<StoredWalletChallenge | null>;
  putSession(session: StoredSession): Promise<void>;
  session(tokenHash: string, at: Date): Promise<StoredSession | null>;
  revokeSession(tokenHash: string): Promise<void>;
  putAlertRule(rule: AlertRule): Promise<void>;
  alertRules(address: string): Promise<AlertRule[]>;
  putOccurrences(occurrences: AlertOccurrence[]): Promise<number>;
  alertOccurrences(address: string): Promise<AlertOccurrence[]>;
  putIntent(intent: StoredIntent): Promise<void>;
  intent(intentId: string): Promise<StoredIntent | null>;
  updateIntent(intentId: string, state: StoredIntent["state"], txid: string | null, at: Date): Promise<StoredIntent | null>;
}

export class MemoryProductStore implements ProductStore {
  private readonly challenges = new Map<string, StoredWalletChallenge>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly rules = new Map<string, AlertRule>();
  private readonly occurrences = new Map<string, AlertOccurrence>();
  private readonly intents = new Map<string, StoredIntent>();

  async putChallenge(challenge: StoredWalletChallenge) { this.challenges.set(challenge.challengeId, challenge); }
  async consumeChallenge(challengeId: string, at: Date) {
    const challenge = this.challenges.get(challengeId);
    if (!challenge || challenge.consumedAt || Date.parse(challenge.expiresAt) <= at.getTime()) return null;
    const consumed = { ...challenge, consumedAt: at.toISOString() };
    this.challenges.set(challengeId, consumed);
    return consumed;
  }
  async putSession(session: StoredSession) { this.sessions.set(session.tokenHash, session); }
  async session(tokenHash: string, at: Date) {
    const session = this.sessions.get(tokenHash);
    return session && Date.parse(session.expiresAt) > at.getTime() ? session : null;
  }
  async revokeSession(value: string) { this.sessions.delete(value); }
  async putAlertRule(rule: AlertRule) { this.rules.set(rule.ruleId, rule); }
  async alertRules(address: string) { return [...this.rules.values()].filter((rule) => rule.address === address); }
  async putOccurrences(occurrences: AlertOccurrence[]) {
    let inserted = 0;
    for (const occurrence of occurrences) {
      if (!this.occurrences.has(occurrence.occurrenceId)) inserted++;
      this.occurrences.set(occurrence.occurrenceId, occurrence);
    }
    return inserted;
  }
  async alertOccurrences(address: string) {
    return [...this.occurrences.values()].filter((item) => item.address === address).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async putIntent(intent: StoredIntent) { this.intents.set(intent.intent.intentId, intent); }
  async intent(intentId: string) { return this.intents.get(intentId) ?? null; }
  async updateIntent(intentId: string, state: StoredIntent["state"], txid: string | null, at: Date) {
    const existing = this.intents.get(intentId);
    if (!existing) return null;
    const updated = { ...existing, state, txid, updatedAt: at.toISOString() };
    this.intents.set(intentId, updated);
    return updated;
  }
}

export class PostgresProductStore implements ProductStore {
  constructor(private readonly sql: Sql) {}
  async putChallenge(value: StoredWalletChallenge) {
    await this.sql`INSERT INTO wallet_challenges ${this.sql({ challenge_id: value.challengeId, address: value.address, network: value.network, message: value.message, expires_at: value.expiresAt })}`;
  }
  async consumeChallenge(challengeId: string, at: Date) {
    const rows = await this.sql`UPDATE wallet_challenges SET consumed_at = ${at} WHERE challenge_id = ${challengeId} AND consumed_at IS NULL AND expires_at > ${at} RETURNING *`;
    return rows[0] ? challengeRow(rows[0]) : null;
  }
  async putSession(value: StoredSession) {
    await this.sql`INSERT INTO wallet_sessions ${this.sql({ token_hash: value.tokenHash, address: value.address, network: value.network, expires_at: value.expiresAt })}`;
  }
  async session(tokenHash: string, at: Date) {
    const rows = await this.sql`SELECT * FROM wallet_sessions WHERE token_hash = ${tokenHash} AND expires_at > ${at}`;
    const row = rows[0];
    return row ? { tokenHash: String(row.token_hash), address: String(row.address), network: String(row.network) as Network, expiresAt: new Date(String(row.expires_at)).toISOString() } : null;
  }
  async revokeSession(tokenHash: string) { await this.sql`DELETE FROM wallet_sessions WHERE token_hash = ${tokenHash}`; }
  async putAlertRule(rule: AlertRule) {
    await this.sql`INSERT INTO alert_rules ${this.sql({ rule_id: rule.ruleId, address: rule.address, name: rule.name, categories: rule.categories, minimum_severity: rule.minimumSeverity, enabled: rule.enabled, cooldown_seconds: rule.cooldownSeconds, created_at: rule.createdAt })}`;
  }
  async alertRules(address: string) {
    const rows = await this.sql`SELECT * FROM alert_rules WHERE address = ${address} ORDER BY created_at DESC`;
    return rows.map(alertRuleRow);
  }
  async putOccurrences(values: AlertOccurrence[]) {
    let inserted = 0;
    for (const value of values) {
      const rows = await this.sql`INSERT INTO alert_occurrences ${this.sql({ occurrence_id: value.occurrenceId, rule_id: value.ruleId, address: value.address, risk_id: value.riskId, severity: value.severity, title: value.title, evidence: this.sql.json(value.evidence as never), state: value.state, opened_at: value.openedAt, updated_at: value.updatedAt })} ON CONFLICT (occurrence_id) DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title, evidence = EXCLUDED.evidence, updated_at = EXCLUDED.updated_at RETURNING (xmax = 0) AS inserted`;
      if (rows[0]?.inserted) inserted++;
    }
    return inserted;
  }
  async alertOccurrences(address: string) {
    const rows = await this.sql`SELECT * FROM alert_occurrences WHERE address = ${address} ORDER BY updated_at DESC`;
    return rows.map((row) => ({ occurrenceId: String(row.occurrence_id), ruleId: String(row.rule_id), address: String(row.address), riskId: String(row.risk_id), severity: String(row.severity) as AlertSeverity, title: String(row.title), evidence: row.evidence as AlertOccurrence["evidence"], state: String(row.state) as AlertOccurrence["state"], openedAt: new Date(String(row.opened_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() }));
  }
  async putIntent(value: StoredIntent) {
    await this.sql`INSERT INTO action_intents ${this.sql({ intent_id: value.intent.intentId, address: value.address, intent_hash: value.intentHash, state: value.state, intent: this.sql.json(value.intent as never), txid: value.txid, updated_at: value.updatedAt })}`;
  }
  async intent(intentId: string) {
    const rows = await this.sql`SELECT * FROM action_intents WHERE intent_id = ${intentId}`;
    return rows[0] ? intentRow(rows[0]) : null;
  }
  async updateIntent(intentId: string, state: StoredIntent["state"], txid: string | null, at: Date) {
    const rows = await this.sql`UPDATE action_intents SET state = ${state}, txid = ${txid}, updated_at = ${at} WHERE intent_id = ${intentId} RETURNING *`;
    return rows[0] ? intentRow(rows[0]) : null;
  }
}

function challengeRow(row: postgres.Row): StoredWalletChallenge {
  return { challengeId: String(row.challenge_id), address: String(row.address), network: String(row.network) as Network, message: String(row.message), expiresAt: new Date(String(row.expires_at)).toISOString(), consumedAt: row.consumed_at ? new Date(String(row.consumed_at)).toISOString() : null };
}
function alertRuleRow(row: postgres.Row): AlertRule {
  return { ruleId: String(row.rule_id), address: String(row.address), name: String(row.name), categories: row.categories as AlertRule["categories"], minimumSeverity: String(row.minimum_severity) as AlertSeverity, enabled: Boolean(row.enabled), cooldownSeconds: Number(row.cooldown_seconds), createdAt: new Date(String(row.created_at)).toISOString() };
}
function intentRow(row: postgres.Row): StoredIntent {
  return { intent: row.intent as TransactionIntent, address: String(row.address), intentHash: String(row.intent_hash), state: String(row.state) as StoredIntent["state"], txid: row.txid ? String(row.txid) : null, updatedAt: new Date(String(row.updated_at)).toISOString() };
}

export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function randomToken(): string { return randomBytes(32).toString("base64url"); }

const severityRank: Record<AlertSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function occurrencesForRule(rule: AlertRule, risks: RiskFinding[], now: Date): AlertOccurrence[] {
  if (!rule.enabled) return [];
  return risks.filter((risk) => rule.categories.includes(risk.category) && severityRank[risk.severity] >= severityRank[rule.minimumSeverity]).map((risk) => ({
    occurrenceId: `al_${createHash("sha256").update(`${rule.ruleId}:${risk.riskId}`).digest("hex").slice(0, 20)}`,
    ruleId: rule.ruleId,
    address: rule.address,
    riskId: risk.riskId,
    severity: risk.severity,
    title: risk.title,
    evidence: risk.evidence,
    state: "open",
    openedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }));
}

export function createAlertRule(input: Pick<AlertRule, "address" | "name" | "categories" | "minimumSeverity">, now: Date): AlertRule {
  return { ...input, ruleId: `rule_${randomUUID()}`, enabled: true, cooldownSeconds: 3600, createdAt: now.toISOString() };
}
