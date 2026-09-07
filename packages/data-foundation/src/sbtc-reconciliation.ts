import { z } from "zod";
import type { ProtocolProjection } from "./protocol-projection.js";

const statusSchema = z.string().transform((value) => value.toLowerCase()).pipe(z.enum(["pending", "accepted", "confirmed", "failed"]));

const emilyWithdrawalSchema = z.object({
  requestId: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]),
  sender: z.string(),
  amount: z.number().int().nonnegative(),
  status: statusSchema,
  txid: z.string().nullable().optional(),
  stacksBlockHash: z.string().optional(),
  stacksBlockHeight: z.number().int().nonnegative().optional(),
  lastUpdateHeight: z.number().int().nonnegative().optional(),
  lastUpdateBlockHash: z.string().optional(),
}).passthrough();

const emilyDepositSchema = z.object({
  bitcoinTxid: z.string(),
  bitcoinTxOutputIndex: z.number().int().nonnegative(),
  recipient: z.string(),
  amount: z.number().int().nonnegative(),
  status: statusSchema,
  statusMessage: z.string().optional(),
  lastUpdateHeight: z.number().int().nonnegative().optional(),
  lastUpdateBlockHash: z.string().optional(),
  fulfillment: z.object({
    BitcoinTxid: z.string(),
    StacksTxid: z.string().optional(),
    BitcoinBlockHash: z.string().optional(),
    BitcoinBlockHeight: z.number().int().nonnegative().optional(),
    BtcFee: z.number().int().nonnegative(),
  }).optional(),
}).passthrough();

export type EmilyWithdrawal = z.infer<typeof emilyWithdrawalSchema>;
export type EmilyDeposit = z.infer<typeof emilyDepositSchema>;

export class SbtcEmilyClient {
  constructor(
    private readonly baseUrl = "https://sbtc-emily.com",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async json(path: string): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Emily returned HTTP ${response.status}`);
    return response.json();
  }

  async withdrawalsBySender(address: string): Promise<EmilyWithdrawal[]> {
    const body = z.object({ withdrawals: z.array(emilyWithdrawalSchema) }).passthrough().parse(
      await this.json(`/withdrawal/sender/${encodeURIComponent(address)}`),
    );
    return body.withdrawals;
  }

  async depositsByTransaction(txid: string): Promise<EmilyDeposit[]> {
    const body = z.object({ deposits: z.array(emilyDepositSchema) }).passthrough().parse(
      await this.json(`/deposit/${encodeURIComponent(txid.replace(/^0x/, ""))}`),
    );
    return body.deposits;
  }
}

const bitcoinStatusSchema = z.object({
  confirmed: z.boolean(),
  block_height: z.number().int().nonnegative().optional(),
  block_hash: z.string().optional(),
});

export interface BitcoinTransactionEvidence {
  txid: string;
  confirmed: boolean;
  blockHeight: number | null;
  blockHash: string | null;
  confirmations: number;
}

export class BitcoinEsploraClient {
  private tip: { height: number; expiresAt: number } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async tipHeight(): Promise<number> {
    if (this.tip && this.tip.expiresAt > Date.now()) return this.tip.height;
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/blocks/tip/height`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Bitcoin provider returned HTTP ${response.status} for tip`);
    const height = Number(await response.text());
    if (!Number.isSafeInteger(height) || height < 0) throw new Error("Bitcoin provider returned an invalid tip height");
    this.tip = { height, expiresAt: Date.now() + 15_000 };
    return height;
  }

  async transaction(txid: string): Promise<BitcoinTransactionEvidence> {
    const clean = txid.replace(/^0x/, "").toLowerCase();
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/tx/${encodeURIComponent(clean)}/status`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return { txid: clean, confirmed: false, blockHeight: null, blockHash: null, confirmations: 0 };
    if (!response.ok) throw new Error(`Bitcoin provider returned HTTP ${response.status} for transaction`);
    const status = bitcoinStatusSchema.parse(await response.json());
    const height = status.block_height ?? null;
    const confirmations = status.confirmed && height !== null ? Math.max(0, (await this.tipHeight()) - height + 1) : 0;
    return { txid: clean, confirmed: status.confirmed, blockHeight: height, blockHash: status.block_hash ?? null, confirmations };
  }
}

export type SbtcLifecycleState =
  | "requested"
  | "signer-accepted"
  | "bitcoin-confirming"
  | "stacks-completed-bitcoin-unverified"
  | "completed"
  | "failed"
  | "evidence-conflict";

export interface ReconciledSbtcOperation {
  operationKey: string;
  direction: "deposit" | "withdrawal";
  state: SbtcLifecycleState;
  canonical: boolean;
  reasons: string[];
  stacksEvents: ProtocolProjection[];
  emily: EmilyWithdrawal | EmilyDeposit | null;
  bitcoin: BitcoinTransactionEvidence[];
}

export function reconcileSbtcOperation(input: {
  operationKey: string;
  direction: "deposit" | "withdrawal";
  stacksEvents: ProtocolProjection[];
  emily: EmilyWithdrawal | EmilyDeposit | null;
  bitcoin: BitcoinTransactionEvidence[];
}): ReconciledSbtcOperation {
  const kinds = new Set(input.stacksEvents.map((event) => event.kind));
  const confirmed = input.bitcoin.length > 0 && input.bitcoin.every((tx) => tx.confirmed && tx.confirmations > 0);
  const emilyStatus = input.emily?.status ?? null;
  let state: SbtcLifecycleState = "requested";
  const reasons: string[] = [];
  const conflicts: string[] = [];

  if (input.direction === "withdrawal") {
    if (kinds.has("withdrawal-reject") || emilyStatus === "failed") state = "failed";
    else if (kinds.has("withdrawal-accept") && confirmed) state = "completed";
    else if (kinds.has("withdrawal-accept")) state = "stacks-completed-bitcoin-unverified";
    else if (confirmed) state = "bitcoin-confirming";
    else if (emilyStatus === "accepted") state = "signer-accepted";
    if (emilyStatus === "confirmed" && (!kinds.has("withdrawal-accept") || !confirmed)) {
      state = "evidence-conflict";
      reasons.push("Emily reports confirmed without canonical Stacks acceptance and confirmed Bitcoin evidence");
    }
  } else {
    const stacksComplete = kinds.has("completed-deposit");
    if (emilyStatus === "failed") state = "failed";
    else if (stacksComplete && confirmed) state = "completed";
    else if (stacksComplete) state = "stacks-completed-bitcoin-unverified";
    else if (confirmed) state = "bitcoin-confirming";
    else if (emilyStatus === "accepted") state = "signer-accepted";
    if (emilyStatus === "confirmed" && (!stacksComplete || !confirmed)) {
      state = "evidence-conflict";
      reasons.push("Emily reports confirmed without canonical completed-deposit and confirmed Bitcoin deposit/sweep evidence");
    }
    const completedEvent = input.stacksEvents.find((event) => event.kind === "completed-deposit");
    const deposit: EmilyDeposit | null = input.emily && "bitcoinTxid" in input.emily
      ? input.emily as EmilyDeposit
      : null;
    if (completedEvent && deposit) {
      if (completedEvent.payload.bitcoinTxid !== deposit.bitcoinTxid.replace(/^0x/, "").toLowerCase()) {
        conflicts.push("Emily deposit transaction does not match the canonical Stacks completed-deposit event");
      }
      if (Number(completedEvent.payload.outputIndex) !== deposit.bitcoinTxOutputIndex) {
        conflicts.push("Emily deposit output index does not match the canonical Stacks event");
      }
      const minted = BigInt(String(completedEvent.payload.amountAtomic));
      const expectedMinted = BigInt(deposit.amount - (deposit.fulfillment?.BtcFee ?? 0));
      if (minted !== expectedMinted) conflicts.push("Emily amount minus the recorded Bitcoin fee does not match the minted sBTC amount");
      const stacksSweep = String(completedEvent.payload.sweepTxid ?? "").replace(/^0x/, "").toLowerCase();
      const emilySweep = deposit.fulfillment?.BitcoinTxid.replace(/^0x/, "").toLowerCase();
      if (emilySweep && stacksSweep !== emilySweep) conflicts.push("Emily fulfillment transaction does not match the canonical Stacks sweep transaction");
    }
  }
  if (conflicts.length > 0) {
    state = "evidence-conflict";
    reasons.push(...conflicts);
  }
  if (state === "completed") reasons.push("Canonical Stacks and confirmed Bitcoin evidence agree");
  return { ...input, state, canonical: state === "completed" || state === "failed", reasons };
}

export async function reconcileSbtcAddress(
  address: string,
  events: ProtocolProjection[],
  emily: SbtcEmilyClient,
  bitcoin: BitcoinEsploraClient,
): Promise<ReconciledSbtcOperation[]> {
  const grouped = new Map<string, ProtocolProjection[]>();
  for (const event of events) grouped.set(event.positionKey, [...(grouped.get(event.positionKey) ?? []), event]);
  const withdrawals = await emily.withdrawalsBySender(address);
  for (const withdrawal of withdrawals) {
    const key = `sbtc:withdrawal:${withdrawal.requestId}`;
    if (!grouped.has(key)) grouped.set(key, []);
  }
  const output: ReconciledSbtcOperation[] = [];
  for (const [operationKey, stacksEvents] of grouped) {
    if (operationKey.startsWith("sbtc:withdrawal:")) {
      const requestId = Number(operationKey.split(":").at(-1));
      const emilyRecord = withdrawals.find((item) => item.requestId === requestId) ?? null;
      const accepted = stacksEvents.find((event) => event.kind === "withdrawal-accept");
      const txids = [...new Set([accepted?.payload.bitcoinTxid, accepted?.payload.sweepTxid, emilyRecord?.txid]
        .filter((item): item is string => typeof item === "string" && item.length > 0))];
      const bitcoinEvidence = await Promise.all(txids.map((txid) => bitcoin.transaction(txid)));
      output.push(reconcileSbtcOperation({ operationKey, direction: "withdrawal", stacksEvents, emily: emilyRecord, bitcoin: bitcoinEvidence }));
    } else {
      const parts = operationKey.split(":");
      const txid = parts[2] ?? "";
      const outputIndex = Number(parts[3]);
      const deposits = await emily.depositsByTransaction(txid);
      const emilyRecord = deposits.find((item) => item.bitcoinTxOutputIndex === outputIndex) ?? null;
      const complete = stacksEvents.find((event) => event.kind === "completed-deposit");
      const sweep = typeof complete?.payload.sweepTxid === "string" ? complete.payload.sweepTxid : null;
      const bitcoinEvidence = await Promise.all([txid, sweep].filter((item): item is string => Boolean(item)).map((item) => bitcoin.transaction(item)));
      output.push(reconcileSbtcOperation({ operationKey, direction: "deposit", stacksEvents, emily: emilyRecord, bitcoin: bitcoinEvidence }));
    }
  }
  return output;
}
