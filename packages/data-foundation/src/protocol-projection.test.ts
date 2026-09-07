import { Cl, serializeCV } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import type { IngestedBlock, IngestedContractEvent } from "./chainhook.js";
import { projectProtocolEvents } from "./protocol-projection.js";
import type { RegistryManifest } from "./registry.js";

const owner = "SP000000000000000000002Q6VF78";
const zestContract = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault";
const zestV08Market = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market";
const bitflowContract = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
const sbtcRegistry = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry";
const sbtcToken = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";

function entry(protocol: string, contractPrincipal: string) {
  return {
    protocol, adapterVersion: "mainnet-v1", network: "mainnet" as const, contractPrincipal,
    interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1, supportedAssets: [], assetDefinitions: [],
    readOnlyFunctions: [], transactionFunctions: [], evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
  };
}

const manifest: RegistryManifest = {
  version: "2026-09-04.1", network: "mainnet", issuedAt: "2026-09-04T00:00:00.000Z", expiresAt: "2027-09-04T00:00:00.000Z",
  entries: [entry("zest-v2", zestContract), entry("zest-v2", zestV08Market), entry("bitflow", bitflowContract), entry("sbtc", sbtcRegistry), entry("sbtc", sbtcToken)],
};

function print(eventKey: string, contractIdentifier: string, value: ReturnType<typeof Cl.tuple>): IngestedContractEvent {
  return { eventKey, eventIndex: Number(eventKey.slice(-1)), eventType: "smart_contract_log", contractIdentifier, topic: "print", value: {
    contract_log: { contract_id: contractIdentifier, topic: "print", value: { hex: serializeCV(value) } },
  } };
}

function block(events: IngestedContractEvent[]): IngestedBlock {
  return { indexBlockHash: "0xindex", blockHash: "0xblock", height: 400_000, parentIndexBlockHash: "0xparent", burnBlockHeight: 900_000, blockTime: null,
    transactions: [{ txId: "0xtx", txIndex: 0, success: true, raw: {}, events }],
  };
}

describe("protocol event projection", () => {
  it("decodes Zest vault ownership and amounts", () => {
    const event = print("event-0", zestContract, Cl.tuple({
      action: Cl.stringAscii("collateral-add"), caller: Cl.standardPrincipal(owner), data: Cl.tuple({
        account: Cl.standardPrincipal(owner), amount: Cl.uint(36_354_339_536n), "asset-id": Cl.uint(5),
        "updated-collateral-amount": Cl.uint(36_354_339_536n),
      }),
    }));
    expect(projectProtocolEvents("mainnet", block([event]), manifest)).toMatchObject({ issues: [], projections: [{
      protocol: "zest", kind: "collateral-add", ownerAddress: owner, positionKey: `zest:${owner}`,
      payload: { amountAtomic: "36354339536", assetId: "5" },
    }] });
  });

  it("uses the deployed Zest scaled-debt field names", () => {
    const event = print("event-0", zestContract, Cl.tuple({ action: Cl.stringAscii("debt-add-scaled"), caller: Cl.standardPrincipal(owner), data: Cl.tuple({
      account: Cl.standardPrincipal(owner), "scaled-amount": Cl.uint(42), "asset-id": Cl.uint(6), "updated-scaled-debt": Cl.uint(100),
      "mask-before": Cl.uint(0), "mask-after": Cl.uint(1),
    }) }));
    expect(projectProtocolEvents("mainnet", block([event]), manifest)).toMatchObject({ issues: [], projections: [{
      kind: "debt-add-scaled", payload: { amountAtomic: "42", amountKind: "scaled-debt", updated_scaled_debt: "100" },
    }] });
  });

  it("projects events emitted by the current v0.8 market contract", () => {
    const event = print("event-0", zestV08Market, Cl.tuple({
      action: Cl.stringAscii("collateral-remove"), caller: Cl.standardPrincipal(owner), data: Cl.tuple({
        account: Cl.standardPrincipal(owner), amount: Cl.uint(156_089_761), "asset-id": Cl.uint(5),
        "updated-collateral-amount": Cl.uint(0),
      }),
    }));
    expect(projectProtocolEvents("mainnet", block([event]), manifest)).toMatchObject({ issues: [], projections: [{
      protocol: "zest", adapterVersion: "mainnet-v1", kind: "collateral-remove", ownerAddress: owner,
      payload: { amountAtomic: "156089761", assetId: "5", updated_collateral_amount: "0" },
    }] });
  });

  it("decodes Bitflow pool-token ownership and liquidity amount", () => {
    const nft: IngestedContractEvent = {
      eventKey: "event-0", eventIndex: 0, eventType: "nft_mint_event", contractIdentifier: null, topic: null,
      value: { data: { asset_identifier: `${bitflowContract}::pool-token-id`, value: { hex: serializeCV(Cl.tuple({ owner: Cl.standardPrincipal(owner), "token-id": Cl.uint(705) })) } } },
    };
    const mint = print("event-1", bitflowContract, Cl.tuple({ action: Cl.stringAscii("pool-mint"), data: Cl.tuple({
      amount: Cl.uint(4_460_759), id: Cl.uint(705), user: Cl.standardPrincipal(owner),
    }) }));
    expect(projectProtocolEvents("mainnet", block([nft, mint]), manifest).projections).toMatchObject([
      { kind: "ownership-mint", ownerAddress: owner, payload: { tokenId: "705" } },
      { kind: "pool-mint", ownerAddress: owner, payload: { tokenId: "705", amountAtomic: "4460759" } },
    ]);
  });

  it("correlates completed sBTC deposits with the transaction mint recipient", () => {
    const txid = "11".repeat(32);
    const sweep = "22".repeat(32);
    const mint: IngestedContractEvent = { eventKey: "event-0", eventIndex: 0, eventType: "ft_mint_event", contractIdentifier: null, topic: null,
      value: { data: { asset_identifier: `${sbtcToken}::sbtc-token`, recipient: owner, amount: "100000" } },
    };
    const completed = print("event-1", sbtcRegistry, Cl.tuple({ topic: Cl.stringAscii("completed-deposit"),
      "bitcoin-txid": Cl.bufferFromHex(txid), "output-index": Cl.uint(0), amount: Cl.uint(100_000),
      "burn-hash": Cl.bufferFromHex("33".repeat(32)), "burn-height": Cl.uint(900_000), "sweep-txid": Cl.bufferFromHex(sweep),
    }));
    expect(projectProtocolEvents("mainnet", block([mint, completed]), manifest)).toMatchObject({ issues: [], projections: [{
      kind: "completed-deposit", ownerAddress: owner, positionKey: `sbtc:deposit:${txid}:0`, payload: { sweepTxid: sweep },
    }] });
  });

  it("quarantines malformed known-contract events instead of inventing facts", () => {
    const event: IngestedContractEvent = { eventKey: "event-0", eventIndex: 0, eventType: "smart_contract_log", contractIdentifier: zestContract, topic: "print", value: {} };
    expect(projectProtocolEvents("mainnet", block([event]), manifest)).toMatchObject({ projections: [], issues: [{ protocol: "zest", code: "decode-failed" }] });
  });
});
