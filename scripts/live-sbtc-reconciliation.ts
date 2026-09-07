import { readFile } from "node:fs/promises";
import { BitcoinEsploraClient, parseChainhookPayload, projectProtocolEvents, reconcileSbtcOperation, SbtcEmilyClient, unwrapRegistryPayload } from "../packages/data-foundation/src/index.js";

type Json = Record<string, unknown>;
const stacksUrl = (process.env.STACKS_API_URL ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
const emily = new SbtcEmilyClient(process.env.SBTC_EMILY_URL ?? "https://sbtc-emily.com");
const bitcoin = new BitcoinEsploraClient(process.env.BITCOIN_ESPLORA_URL ?? "https://mempool.space/api");
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-04.2.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(signedPath, "utf8"))).manifest;
const registry = manifest.entries.find((entry) => entry.enabled && entry.protocol === "sbtc" && entry.contractPrincipal.endsWith(".sbtc-registry"));
if (!registry) throw new Error("Active registry has no sBTC registry contract");

async function json(path: string): Promise<Json> {
  const response = await fetch(`${stacksUrl}${path}`, {
    headers: { accept: "application/json", ...(process.env.HIRO_API_KEY ? { "x-api-key": process.env.HIRO_API_KEY } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Stacks API ${path} returned ${response.status}`);
  return await response.json() as Json;
}

const page = await json(`/extended/v1/contract/${encodeURIComponent(registry.contractPrincipal)}/events?limit=25&offset=0`);
const event = (Array.isArray(page.results) ? page.results : []).find((item) => {
  const value = (item as { contract_log?: { value?: { repr?: string } } }).contract_log?.value?.repr;
  return value?.includes('(topic "completed-deposit")');
}) as Json | undefined;
if (!event || typeof event.tx_id !== "string") throw new Error("No recent completed sBTC deposit was available for live reconciliation");

const tx = await json(`/extended/v1/tx/${event.tx_id}`);
const height = Number(tx.block_height);
if (!Number.isSafeInteger(height)) throw new Error("sBTC transaction has no valid block height");
const block = await json(`/extended/v2/blocks/${height}`);
const payload = {
  rollback: [],
  apply: [{
    block_identifier: { index: height, hash: String(block.hash) },
    parent_block_identifier: { index: Math.max(0, height - 1), hash: String(block.parent_block_hash ?? block.parent_index_block_hash) },
    timestamp: block.block_time,
    metadata: {
      index_block_hash: block.index_block_hash,
      parent_index_block_hash: block.parent_index_block_hash,
      burn_block_height: block.burn_block_height,
      block_time: block.block_time,
    },
    transactions: [{
      transaction_identifier: { hash: tx.tx_id },
      metadata: { position: tx.tx_index, success: tx.tx_status === "success", receipt: { events: tx.events } },
    }],
  }],
};
const parsed = parseChainhookPayload(payload, { network: "mainnet", source: "live-sbtc-smoke" });
const projected = projectProtocolEvents("mainnet", parsed.apply[0]!, manifest);
const completed = projected.projections.find((item) => item.kind === "completed-deposit");
if (!completed) throw new Error(`Recent sBTC transaction did not project: ${projected.issues.map((issue) => issue.detail).join("; ")}`);

const bitcoinTxid = String(completed.payload.bitcoinTxid);
const outputIndex = Number(completed.payload.outputIndex);
const deposits = await emily.depositsByTransaction(bitcoinTxid);
const emilyDeposit = deposits.find((item) => item.bitcoinTxOutputIndex === outputIndex) ?? null;
const sweepTxid = String(completed.payload.sweepTxid);
const bitcoinEvidence = await Promise.all([bitcoin.transaction(bitcoinTxid), bitcoin.transaction(sweepTxid)]);
const result = reconcileSbtcOperation({
  operationKey: completed.positionKey,
  direction: "deposit",
  stacksEvents: [completed],
  emily: emilyDeposit,
  bitcoin: bitcoinEvidence,
});
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  stacks: { txid: completed.txId, blockHeight: completed.blockHeight, indexBlockHash: completed.indexBlockHash, owner: completed.ownerAddress },
  emily: emilyDeposit ? { status: emilyDeposit.status, amount: emilyDeposit.amount, fee: emilyDeposit.fulfillment?.BtcFee ?? null } : null,
  bitcoin: bitcoinEvidence,
  reconciliation: { state: result.state, canonical: result.canonical, reasons: result.reasons },
}, null, 2));
if (result.state !== "completed" || !result.canonical) process.exitCode = 1;
