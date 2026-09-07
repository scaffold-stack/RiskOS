import { describe, expect, it, vi } from "vitest";
import { parseChainhookPayload } from "./chainhook.js";
import { StacksBlockReconciler } from "./reconciliation.js";
import { MemoryDataFoundationStore } from "./store.js";

describe("Stacks canonical reconciliation", () => {
  it("marks hash disagreements red", async () => {
    const store = new MemoryDataFoundationStore();
    await store.ingest(parseChainhookPayload({
      rollback: [],
      apply: [{ block_identifier: { index: 10, hash: "local-hash" }, metadata: { index_block_hash: "local-index" }, transactions: [] }],
    }, { network: "mainnet" }));
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      canonical: true,
      height: 10,
      hash: "remote-hash",
      index_block_hash: "remote-index",
      parent_index_block_hash: "parent",
      burn_block_height: 100,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await new StacksBlockReconciler(store, "https://example.test", request).reconcile("mainnet", 10);
    expect(result.state).toBe("red");
    expect((await store.sourceHealth()).find((source) => source.sourceId === "hiro-stacks-api")).toMatchObject({ sourceId: "hiro-stacks-api", state: "red" });
  });
});
