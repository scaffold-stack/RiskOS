import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

const identifierSchema = z.object({
  index: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]),
  hash: z.string().min(1),
}).passthrough();

const chainhookBlockSchema = z.object({
  block_identifier: identifierSchema,
  parent_block_identifier: identifierSchema.optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  transactions: z.array(z.unknown()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const chainhookPayloadSchema = z.object({
  apply: z.array(chainhookBlockSchema).default([]),
  rollback: z.array(chainhookBlockSchema).default([]),
  chainhook: z.object({ uuid: z.string().optional() }).passthrough().optional(),
}).passthrough();

export interface IngestedContractEvent {
  eventKey: string;
  eventIndex: number;
  eventType: string;
  contractIdentifier: string | null;
  topic: string | null;
  value: unknown;
}

export interface IngestedTransaction {
  txId: string;
  txIndex: number;
  success: boolean | null;
  raw: unknown;
  events: IngestedContractEvent[];
}

export interface IngestedBlock {
  indexBlockHash: string;
  blockHash: string;
  height: number;
  parentIndexBlockHash: string | null;
  burnBlockHeight: number | null;
  blockTime: string | null;
  transactions: IngestedTransaction[];
}

export interface ChainhookBatch {
  eventKey: string;
  payloadSha256: string;
  source: string;
  network: "mainnet" | "testnet";
  payload: unknown;
  apply: IngestedBlock[];
  rollback: IngestedBlock[];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseEvents(txId: string, indexBlockHash: string, rawTransaction: Record<string, unknown>): IngestedContractEvent[] {
  const metadata = object(rawTransaction.metadata);
  const receipt = object(metadata.receipt);
  const rawEvents = Array.isArray(receipt.events)
    ? receipt.events
    : Array.isArray(metadata.events) ? metadata.events : [];
  return rawEvents.map((rawEvent, eventIndex) => {
    const event = object(rawEvent);
    const data = object(event.data);
    // Chainhook deliveries use `data`, while Hiro's extended transaction API
    // returns typed envelopes such as `contract_log`, `ft_asset`, and
    // `non_fungible_token_asset`. Normalize both so live backfills project the
    // exact same canonical event model as webhook ingestion.
    const contractLog = object(event.contract_log);
    const ftAsset = object(event.ft_asset);
    const nftAsset = object(event.non_fungible_token_asset);
    const stxAsset = object(event.stx_asset);
    const genericAsset = object(event.asset);
    const rawEventType = text(event.type) ?? text(event.event_type) ?? "unknown";
    const assetAction = text(genericAsset.asset_event_type);
    const eventType = rawEventType === "fungible_token_asset" && assetAction
      ? `ft_${assetAction}_event`
      : rawEventType === "non_fungible_token_asset" && assetAction
        ? `nft_${assetAction}_event`
        : rawEventType;
    const contractIdentifier = text(data.contract_identifier)
      ?? text(data.contract_id)
      ?? text(event.contract_identifier)
      ?? text(contractLog.contract_id);
    const topic = text(data.topic) ?? text(event.topic) ?? text(contractLog.topic);
    const normalizedValue = Object.keys(data).length > 0
      ? rawEvent
      : Object.keys(contractLog).length > 0
        ? { ...event, data: contractLog }
        : Object.keys(ftAsset).length > 0
          ? { ...event, data: ftAsset }
          : Object.keys(nftAsset).length > 0
            ? { ...event, data: nftAsset }
            : Object.keys(stxAsset).length > 0
              ? { ...event, data: stxAsset }
              : Object.keys(genericAsset).length > 0
                ? { ...event, data: { ...genericAsset, asset_identifier: genericAsset.asset_identifier ?? genericAsset.asset_id } }
                : rawEvent;
    return {
      eventKey: createHash("sha256").update(`${indexBlockHash}:${txId}:${integer(event.event_index) ?? eventIndex}:${canonicalJson(event)}`).digest("hex"),
      eventIndex: integer(event.event_index) ?? eventIndex,
      eventType,
      contractIdentifier,
      topic,
      value: normalizedValue,
    };
  });
}

function parseTransaction(raw: unknown, fallbackIndex: number, indexBlockHash: string): IngestedTransaction {
  const transaction = object(raw);
  const identifier = object(transaction.transaction_identifier);
  const metadata = object(transaction.metadata);
  const txId = text(identifier.hash) ?? text(transaction.tx_id);
  if (!txId) throw new Error(`Chainhook transaction at index ${fallbackIndex} has no transaction id`);
  const txIndex = integer(metadata.position?.valueOf()) ?? integer(transaction.tx_index) ?? fallbackIndex;
  const successValue = metadata.success ?? transaction.success;
  const success = typeof successValue === "boolean" ? successValue : null;
  return { txId, txIndex, success, raw, events: parseEvents(txId, indexBlockHash, transaction) };
}

function parseBlock(raw: z.infer<typeof chainhookBlockSchema>): IngestedBlock {
  const metadata = object(raw.metadata);
  const bitcoinAnchor = object(metadata.bitcoin_anchor_block_identifier);
  const indexBlockHash = text(metadata.index_block_hash) ?? raw.block_identifier.hash;
  const parentIndexBlockHash = text(metadata.parent_index_block_hash) ?? raw.parent_block_identifier?.hash ?? null;
  return {
    indexBlockHash,
    blockHash: raw.block_identifier.hash,
    height: raw.block_identifier.index,
    parentIndexBlockHash,
    burnBlockHeight: integer(bitcoinAnchor.index) ?? integer(metadata.burn_block_height),
    blockTime: timestamp(raw.timestamp ?? metadata.block_time),
    transactions: raw.transactions.map((transaction, index) => parseTransaction(transaction, index, indexBlockHash)),
  };
}

export function parseChainhookPayload(
  input: unknown,
  options: { source?: string; network: "mainnet" | "testnet"; deliveryId?: string },
): ChainhookBatch {
  const payload = chainhookPayloadSchema.parse(input);
  if (payload.apply.length === 0 && payload.rollback.length === 0) throw new Error("Chainhook payload contains no apply or rollback blocks");
  const serialized = canonicalJson(input);
  const payloadSha256 = createHash("sha256").update(serialized).digest("hex");
  const source = options.source ?? `hiro-chainhooks:${payload.chainhook?.uuid ?? "unidentified"}`;
  return {
    eventKey: options.deliveryId ? `${source}:${options.deliveryId}` : `${source}:${payloadSha256}`,
    payloadSha256,
    source,
    network: options.network,
    payload: input,
    rollback: payload.rollback.map(parseBlock).sort((a, b) => b.height - a.height),
    apply: payload.apply.map(parseBlock).sort((a, b) => a.height - b.height),
  };
}
