import { describe, expect, it } from "vitest";
import { parseChainhookPayload } from "./chainhook.js";
import { MemoryDataFoundationStore } from "./store.js";

function block(height: number, hash: string, parent: string) {
  return {
    block_identifier: { index: height, hash },
    parent_block_identifier: { index: height - 1, hash: parent },
    timestamp: 1_788_400_000,
    metadata: { index_block_hash: `index-${hash}`, burn_block_height: 966_350 + height },
    transactions: [{
      transaction_identifier: { hash: `tx-${hash}` },
      metadata: {
        success: true,
        receipt: { events: [{ type: "contract_event", data: { contract_identifier: "ST123.protocol", topic: "position-change" } }] },
      },
    }],
  };
}

describe("Chainhook ingestion", () => {
  it("is idempotent and rolls canonical state and snapshots back on a reorg", async () => {
    const store = new MemoryDataFoundationStore();
    const firstPayload = { chainhook: { uuid: "positions" }, apply: [block(101, "a", "parent")], rollback: [] };
    const first = parseChainhookPayload(firstPayload, { network: "testnet", deliveryId: "delivery-1" });
    expect(await store.ingest(first)).toMatchObject({ duplicate: false, appliedBlocks: 1 });
    expect(await store.ingest(first)).toMatchObject({ duplicate: true, appliedBlocks: 0 });
    const reused = parseChainhookPayload({ ...firstPayload, apply: [block(102, "different", "a")] }, { network: "testnet", deliveryId: "delivery-1" });
    await expect(store.ingest(reused)).rejects.toThrow(/reused with different payload/);
    store.addSnapshot("snapshot-a", "index-a");

    const reorgPayload = {
      chainhook: { uuid: "positions" },
      rollback: [block(101, "a", "parent")],
      apply: [block(101, "b", "parent")],
    };
    const result = await store.ingest(parseChainhookPayload(reorgPayload, { network: "testnet", deliveryId: "delivery-2" }));
    expect(result).toMatchObject({ rolledBackBlocks: 1, appliedBlocks: 1, invalidatedSnapshots: 1 });
    expect((await store.canonicalBlock("testnet", 101))?.indexBlockHash).toBe("index-b");
    expect(store.snapshots.get("snapshot-a")?.invalidated).toBe(true);
  });

  it("rejects payloads without chain mutations", () => {
    expect(() => parseChainhookPayload({}, { network: "mainnet" })).toThrow(/no apply or rollback/);
  });

  it("normalizes Hiro extended API contract events without losing their canonical event index", () => {
    const payload = {
      rollback: [],
      apply: [{
        block_identifier: { index: 8_919_430, hash: "block-hash" },
        metadata: { index_block_hash: "index-hash" },
        transactions: [{
          transaction_identifier: { hash: "0xmainnet" },
          metadata: {
            success: true,
            receipt: { events: [{
              event_index: 7,
              event_type: "smart_contract_log",
              tx_id: "0xmainnet",
              contract_log: {
                contract_id: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
                topic: "print",
                value: { hex: "0x00", repr: "0" },
              },
            }] },
          },
        }],
      }],
    };
    const event = parseChainhookPayload(payload, { network: "mainnet" }).apply[0]?.transactions[0]?.events[0];
    expect(event).toMatchObject({
      eventIndex: 7,
      eventType: "smart_contract_log",
      contractIdentifier: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
      topic: "print",
      value: { data: { contract_id: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market" } },
    });
  });

  it("normalizes current Hiro fungible-token asset envelopes for ownership projection", () => {
    const payload = { rollback: [], apply: [{
      block_identifier: { index: 8_919_396, hash: "block" }, metadata: { index_block_hash: "index" },
      transactions: [{ transaction_identifier: { hash: "0xsbtc" }, metadata: { success: true, receipt: { events: [{
        event_index: 0, event_type: "fungible_token_asset", tx_id: "0xsbtc", asset: {
          asset_event_type: "mint", asset_id: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
          sender: "", recipient: "SP000000000000000000002Q6VF78.pox-5", amount: "54544",
        },
      }] } } }],
    }] };
    expect(parseChainhookPayload(payload, { network: "mainnet" }).apply[0]?.transactions[0]?.events[0]).toMatchObject({
      eventIndex: 0, eventType: "ft_mint_event", value: { data: {
        asset_identifier: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
        recipient: "SP000000000000000000002Q6VF78.pox-5", amount: "54544",
      } },
    });
  });
});
