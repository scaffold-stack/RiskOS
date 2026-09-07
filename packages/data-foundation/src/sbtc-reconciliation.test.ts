import { describe, expect, it } from "vitest";
import { reconcileSbtcOperation, type BitcoinTransactionEvidence } from "./sbtc-reconciliation.js";
import type { ProtocolProjection } from "./protocol-projection.js";

function event(kind: string): ProtocolProjection {
  return { projectionId: kind, sourceEventKey: kind, network: "mainnet", indexBlockHash: "index", blockHeight: 1, txId: "tx", eventIndex: 0,
    protocol: "sbtc", adapterVersion: "v1", kind, ownerAddress: null, positionKey: "sbtc:withdrawal:7", payload: {},
  };
}
const confirmed: BitcoinTransactionEvidence = { txid: "aa", confirmed: true, blockHeight: 1, blockHash: "bb", confirmations: 2 };

describe("sBTC lifecycle reconciliation", () => {
  it("only completes with canonical Stacks and Bitcoin evidence", () => {
    expect(reconcileSbtcOperation({ operationKey: "sbtc:withdrawal:7", direction: "withdrawal", stacksEvents: [event("withdrawal-accept")], emily: null, bitcoin: [confirmed] })).toMatchObject({ state: "completed", canonical: true });
  });

  it("flags Emily-only confirmation as an evidence conflict", () => {
    const emily = { requestId: 7, sender: "SP000000000000000000002Q6VF78", amount: 1, status: "confirmed" as const };
    expect(reconcileSbtcOperation({ operationKey: "sbtc:withdrawal:7", direction: "withdrawal", stacksEvents: [], emily, bitcoin: [] })).toMatchObject({ state: "evidence-conflict", canonical: false });
  });

  it("rejects a confirmed deposit when Emily amount and sweep evidence disagree", () => {
    const depositEvent = { ...event("completed-deposit"), positionKey: "sbtc:deposit:aa:1", payload: {
      bitcoinTxid: "aa", outputIndex: "1", amountAtomic: "54544", sweepTxid: "bb",
    } };
    const emily = {
      bitcoinTxid: "aa", bitcoinTxOutputIndex: 1, recipient: "SP000000000000000000002Q6VF78", amount: 55_000,
      status: "confirmed" as const, fulfillment: { BitcoinTxid: "cc", BtcFee: 456 },
    };
    expect(reconcileSbtcOperation({ operationKey: depositEvent.positionKey, direction: "deposit", stacksEvents: [depositEvent], emily, bitcoin: [confirmed] })).toMatchObject({
      state: "evidence-conflict", canonical: false,
      reasons: [expect.stringMatching(/fulfillment transaction/)],
    });
  });
});
