import { ClarityType, hexToCV, type ClarityValue } from "@stacks/transactions";
import { createHash } from "node:crypto";
import type { IngestedBlock, IngestedContractEvent, IngestedTransaction } from "./chainhook.js";
import { canonicalJson } from "./canonical-json.js";
import type { RegistryManifest } from "./registry.js";

export type ProjectionProtocol = "zest" | "bitflow" | "sbtc";

export const PROJECTION_PROTOCOLS: readonly ProjectionProtocol[] = ["zest", "bitflow", "sbtc"];

/** Registry contracts whose historical events decode into protocol_projection_events. */
export function isProjectionBackfillContract(entry: RegistryManifest["entries"][number]): boolean {
  if (!entry.enabled) return false;
  if (entry.protocol.startsWith("zest")) {
    return entry.contractPrincipal.endsWith(".v0-market-vault")
      || entry.contractPrincipal.endsWith(".v0-8-market")
      || entry.contractPrincipal.includes(".v0-vault-");
  }
  if (entry.protocol === "bitflow") return entry.contractPrincipal.includes(".dlmm-pool-");
  if (entry.protocol === "sbtc") return entry.contractPrincipal.endsWith(".sbtc-registry");
  return false;
}

export function projectionBackfillContracts(manifest: RegistryManifest): RegistryManifest["entries"] {
  return manifest.entries.filter(isProjectionBackfillContract);
}

export interface ProtocolProjection {
  projectionId: string;
  sourceEventKey: string;
  network: "mainnet" | "testnet";
  indexBlockHash: string;
  blockHeight: number;
  txId: string;
  eventIndex: number;
  protocol: ProjectionProtocol;
  adapterVersion: string;
  kind: string;
  ownerAddress: string | null;
  positionKey: string;
  payload: Record<string, unknown>;
}

export interface ProjectionIssue {
  sourceEventKey: string;
  protocol: ProjectionProtocol;
  code: "unsupported-shape" | "decode-failed";
  detail: string;
}

export interface ProjectionResult {
  projections: ProtocolProjection[];
  issues: ProjectionIssue[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventData(event: IngestedContractEvent): Record<string, unknown> {
  const raw = record(event.value);
  return record(raw.data ?? raw.contract_log ?? raw);
}

function eventHex(event: IngestedContractEvent): string | null {
  const raw = record(event.value);
  const data = eventData(event);
  const candidates = [data.hex_value, data.hex_asset_identifier, raw.hex_value, raw.hex_asset_identifier, data.value, raw.value, record(data.contract_log).value, record(raw.contract_log).value];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^(0x)?[a-fA-F0-9]+$/.test(candidate)) return candidate;
    const hex = string(record(candidate).hex);
    if (hex && /^(0x)?[a-fA-F0-9]+$/.test(hex)) return hex;
  }
  return null;
}

function assetIdentifier(event: IngestedContractEvent): string | null {
  const raw = record(event.value);
  const data = eventData(event);
  return string(data.asset_identifier) ?? string(data.asset) ?? string(raw.asset_identifier) ?? string(raw.asset);
}

function tuple(value: ClarityValue): Record<string, ClarityValue> {
  if (value.type !== ClarityType.Tuple) throw new Error("expected a Clarity tuple");
  return value.value;
}

function field(value: Record<string, ClarityValue>, name: string): ClarityValue {
  const result = value[name];
  if (!result) throw new Error(`missing Clarity field ${name}`);
  return result;
}

function uint(value: ClarityValue): string {
  if (value.type !== ClarityType.UInt) throw new Error("expected a Clarity uint");
  return BigInt(value.value).toString();
}

function text(value: ClarityValue): string {
  if (value.type !== ClarityType.StringASCII && value.type !== ClarityType.StringUTF8) throw new Error("expected a Clarity string");
  return value.value;
}

function principal(value: ClarityValue): string {
  if (value.type !== ClarityType.PrincipalStandard && value.type !== ClarityType.PrincipalContract) throw new Error("expected a Clarity principal");
  return value.value;
}

function buffer(value: ClarityValue): string {
  if (value.type !== ClarityType.Buffer) throw new Error("expected a Clarity buffer");
  return value.value.toLowerCase();
}

function projectionId(input: Omit<ProtocolProjection, "projectionId">): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function complete(input: Omit<ProtocolProjection, "projectionId">): ProtocolProjection {
  return { projectionId: projectionId(input), ...input };
}

function base(
  network: "mainnet" | "testnet",
  block: IngestedBlock,
  tx: IngestedTransaction,
  event: IngestedContractEvent,
  protocol: ProjectionProtocol,
  adapterVersion: string,
) {
  return {
    sourceEventKey: event.eventKey,
    network,
    indexBlockHash: block.indexBlockHash,
    blockHeight: block.height,
    txId: tx.txId,
    eventIndex: event.eventIndex,
    protocol,
    adapterVersion,
  } as const;
}

function decodeZest(
  common: ReturnType<typeof base>,
  event: IngestedContractEvent,
): ProtocolProjection | null {
  const hex = eventHex(event);
  if (!hex) throw new Error("Zest print event has no Clarity value hex");
  const root = tuple(hexToCV(hex));
  const kind = text(field(root, "action"));
  const data = tuple(field(root, "data"));
  if (kind === "deposit") {
    const ownerAddress = principal(field(data, "recipient"));
    return complete({
      ...common,
      kind: "vault-deposit",
      ownerAddress,
      positionKey: `zest:${ownerAddress}:vault:${event.contractIdentifier}`,
      payload: {
        vaultContract: event.contractIdentifier,
        underlyingAmountAtomic: uint(field(data, "amount")),
        sharesMintedAtomic: uint(field(data, "shares-minted")),
        depositor: principal(field(data, "depositor")),
      },
    });
  }
  if (kind === "redeem") {
    const ownerAddress = principal(field(data, "recipient"));
    return complete({
      ...common,
      kind: "vault-redeem",
      ownerAddress,
      positionKey: `zest:${ownerAddress}:vault:${event.contractIdentifier}`,
      payload: {
        vaultContract: event.contractIdentifier,
        underlyingAmountAtomic: uint(field(data, "amount-received")),
        sharesBurnedAtomic: uint(field(data, "shares-burned")),
        redeemer: principal(field(data, "redeemer")),
      },
    });
  }
  if (!new Set(["collateral-add", "collateral-remove", "debt-add-scaled", "debt-remove-scaled"]).has(kind)) return null;
  const ownerAddress = principal(field(data, "account"));
  const isDebt = kind.startsWith("debt-");
  const payload: Record<string, unknown> = {
    amountAtomic: uint(field(data, isDebt ? "scaled-amount" : "amount")),
    amountKind: isDebt ? "scaled-debt" : "collateral",
    assetId: uint(field(data, "asset-id")),
  };
  for (const name of ["updated-collateral-amount", "updated-scaled-debt"]) {
    if (data[name]) payload[name.replaceAll("-", "_")] = uint(data[name]);
  }
  return complete({ ...common, kind, ownerAddress, positionKey: `zest:${ownerAddress}`, payload });
}

function decodeBitflow(
  common: ReturnType<typeof base>,
  event: IngestedContractEvent,
  poolContract: string,
): ProtocolProjection | null {
  const type = event.eventType.toLowerCase();
  const asset = assetIdentifier(event);
  const hex = eventHex(event);
  if (asset === `${poolContract}::pool-token-id` && type.includes("nft")) {
    if (!hex) throw new Error("Bitflow pool-token NFT event has no Clarity value hex");
    const token = tuple(hexToCV(hex));
    const ownerAddress = principal(field(token, "owner"));
    const tokenId = uint(field(token, "token-id"));
    const action = type.includes("mint") ? "ownership-mint" : type.includes("burn") ? "ownership-burn" : "ownership-transfer";
    return complete({ ...common, kind: action, ownerAddress, positionKey: `bitflow:${poolContract}:${tokenId}`, payload: { tokenId, assetIdentifier: asset } });
  }
  if (event.contractIdentifier !== poolContract || !hex) return null;
  const root = tuple(hexToCV(hex));
  if (!root.action) return null;
  const action = text(root.action);
  if (action !== "pool-mint" && action !== "pool-burn") return null;
  const data = tuple(field(root, "data"));
  const ownerAddress = principal(field(data, "user"));
  const tokenId = uint(field(data, "id"));
  return complete({
    ...common,
    kind: action,
    ownerAddress,
    positionKey: `bitflow:${poolContract}:${tokenId}`,
    payload: { tokenId, amountAtomic: uint(field(data, "amount")) },
  });
}

function decodeSbtc(common: ReturnType<typeof base>, event: IngestedContractEvent, tx: IngestedTransaction, tokenContract: string | null): ProtocolProjection | null {
  const hex = eventHex(event);
  if (!hex) throw new Error("sBTC registry print event has no Clarity value hex");
  const root = tuple(hexToCV(hex));
  const topic = text(field(root, "topic"));
  if (topic === "withdrawal-create") {
    const requestId = uint(field(root, "request-id"));
    const ownerAddress = principal(field(root, "sender"));
    return complete({ ...common, kind: topic, ownerAddress, positionKey: `sbtc:withdrawal:${requestId}`, payload: {
      requestId, amountAtomic: uint(field(root, "amount")), maxFeeAtomic: uint(field(root, "max-fee")),
    } });
  }
  if (topic === "withdrawal-accept") {
    const requestId = uint(field(root, "request-id"));
    return complete({ ...common, kind: topic, ownerAddress: null, positionKey: `sbtc:withdrawal:${requestId}`, payload: {
      requestId, bitcoinTxid: buffer(field(root, "bitcoin-txid")), sweepTxid: buffer(field(root, "sweep-txid")),
      outputIndex: uint(field(root, "output-index")), feeAtomic: uint(field(root, "fee")), burnHeight: uint(field(root, "burn-height")),
    } });
  }
  if (topic === "withdrawal-reject") {
    const requestId = uint(field(root, "request-id"));
    return complete({ ...common, kind: topic, ownerAddress: null, positionKey: `sbtc:withdrawal:${requestId}`, payload: { requestId } });
  }
  if (topic === "completed-deposit") {
    const txid = buffer(field(root, "bitcoin-txid"));
    const outputIndex = uint(field(root, "output-index"));
    const mints = tokenContract ? tx.events.filter((candidate) => {
      const data = eventData(candidate);
      const amount = string(data.amount) ?? string(record(data.value).amount);
      return candidate.eventType.toLowerCase().includes("ft") && candidate.eventType.toLowerCase().includes("mint")
        && assetIdentifier(candidate)?.startsWith(`${tokenContract}::`) === true
        && amount === uint(field(root, "amount"));
    }) : [];
    if (mints.length > 1) throw new Error("completed-deposit has ambiguous same-amount sBTC mint recipients");
    const mint = mints[0];
    const mintData = mint ? eventData(mint) : {};
    const recipient = root.recipient ? principal(root.recipient) : string(mintData.recipient);
    if (!recipient) throw new Error("completed-deposit has no unique approved sBTC mint recipient");
    return complete({ ...common, kind: topic, ownerAddress: recipient, positionKey: `sbtc:deposit:${txid}:${outputIndex}`, payload: {
      bitcoinTxid: txid, outputIndex, amountAtomic: uint(field(root, "amount")), sweepTxid: buffer(field(root, "sweep-txid")), burnHeight: uint(field(root, "burn-height")),
    } });
  }
  return null;
}

export function projectProtocolEvents(
  network: "mainnet" | "testnet",
  block: IngestedBlock,
  manifest: RegistryManifest | null,
): ProjectionResult {
  if (!manifest || manifest.network !== network) return { projections: [], issues: [] };
  const enabled = manifest.entries.filter((entry) => entry.enabled && entry.activationBlock <= block.height);
  const zestContracts = enabled.filter((entry) => entry.protocol.startsWith("zest") && (
    entry.contractPrincipal.endsWith(".v0-market-vault")
    || entry.contractPrincipal.endsWith(".v0-8-market")
    || entry.contractPrincipal.includes(".v0-vault-")
  ));
  const bitflowPools = enabled.filter((entry) => entry.protocol === "bitflow" && entry.contractPrincipal.includes(".dlmm-pool-"));
  const sbtc = enabled.find((entry) => entry.protocol === "sbtc" && entry.contractPrincipal.endsWith(".sbtc-registry"));
  const sbtcToken = enabled.find((entry) => entry.protocol === "sbtc" && entry.contractPrincipal.endsWith(".sbtc-token"));
  const projections: ProtocolProjection[] = [];
  const issues: ProjectionIssue[] = [];
  for (const tx of block.transactions) {
    if (tx.success !== true) continue;
    for (const event of tx.events) {
    let protocol: ProjectionProtocol | null = null;
    let adapterVersion = "";
    try {
      let decoded: ProtocolProjection | null = null;
      const zest = zestContracts.find((entry) => event.contractIdentifier === entry.contractPrincipal);
      const bitflow = bitflowPools.find(
        (entry) =>
          event.contractIdentifier === entry.contractPrincipal ||
          assetIdentifier(event) === `${entry.contractPrincipal}::pool-token-id`,
      );
      if (zest) {
        protocol = "zest"; adapterVersion = zest.adapterVersion;
        decoded = decodeZest(base(network, block, tx, event, protocol, adapterVersion), event);
      } else if (bitflow) {
        protocol = "bitflow"; adapterVersion = bitflow.adapterVersion;
        decoded = decodeBitflow(base(network, block, tx, event, protocol, adapterVersion), event, bitflow.contractPrincipal);
      } else if (sbtc && event.contractIdentifier === sbtc.contractPrincipal) {
        protocol = "sbtc"; adapterVersion = sbtc.adapterVersion;
        decoded = decodeSbtc(base(network, block, tx, event, protocol, adapterVersion), event, tx, sbtcToken?.contractPrincipal ?? null);
      }
      if (decoded) projections.push(decoded);
    } catch (error) {
      if (protocol) issues.push({ sourceEventKey: event.eventKey, protocol, code: "decode-failed", detail: error instanceof Error ? error.message : "event decode failed" });
    }
    }
  }
  return { projections, issues };
}
