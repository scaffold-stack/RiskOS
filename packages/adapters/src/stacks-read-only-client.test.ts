import { describe, expect, it, vi } from "vitest";
import { StacksReadOnlyClient } from "./stacks-read-only-client.js";

describe("StacksReadOnlyClient", () => {
  it("preserves an embedded provider token without introducing a double slash", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [{ canonical: true, height: 123, index_block_hash: "0xabc" }],
    }), { status: 200 }));

    await new StacksReadOnlyClient(
      "https://reference.example/private-token/",
      request,
    ).pinTip();

    expect(String(request.mock.calls[0]![0])).toBe(
      "https://reference.example/private-token/extended/v2/blocks?limit=1",
    );
  });

  it("pins an explicitly requested canonical historical block", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      canonical: true,
      height: 456,
      index_block_hash: "0xdef",
    }), { status: 200 }));

    const pinned = await new StacksReadOnlyClient("https://stacks.example", request).pinBlock(456);

    expect(pinned.blockHeight).toBe(456);
    expect(pinned.indexBlockHash).toBe("0xdef");
    expect(String(request.mock.calls[0]![0])).toBe("https://stacks.example/extended/v2/blocks/456");
  });

  it("rejects a historical block response for a different height", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      canonical: true,
      height: 455,
      index_block_hash: "0xdef",
    }), { status: 200 }));

    await expect(new StacksReadOnlyClient("https://stacks.example", request).pinBlock(456))
      .rejects.toThrow("returned height 455, expected 456");
  });
});
