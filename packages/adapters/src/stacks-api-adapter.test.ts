import { describe, expect, it, vi } from "vitest";
import { StacksApiAdapter } from "./stacks-api-adapter.js";

describe("StacksApiAdapter", () => {
  it("marks unknown token metadata as unsupported instead of guessing decimals", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      const payload = url.endsWith("/balances/stx")
        ? { balance: "123000000" }
        : { results: [{ asset_identifier: "SP123.token::mystery", balance: "99" }], cursor: { next: null } };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    const positions = await new StacksApiAdapter("https://example.test", request).discover("SP000000000000000000002Q6VF78");
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({ type: "wallet", asset: { asset: "STX", decimals: 6 } });
    expect(positions[1]).toMatchObject({ confidence: { state: "unsupported" }, asset: { decimals: 0 } });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("hydrates token metadata only from a verified registry provider", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith("/balances/stx")
        ? { balance: "0" }
        : { results: [{ asset_identifier: "SP123.token::asset", balance: "120000000" }], cursor: { next: null } },
    ), { status: 200 }));
    const positions = await new StacksApiAdapter("https://example.test", request, undefined, async () => [{
      assetIdentifier: "SP123.token::asset", symbol: "sBTC", decimals: 8, spendable: true,
    }]).discover("SP000000000000000000002Q6VF78");
    expect(positions[1]).toMatchObject({
      type: "wallet", asset: { asset: "sBTC", decimals: 8 }, spendable: true,
      confidence: { state: "verified" },
    });
  });

  it("does not emit protocol ownership receipts as standalone wallet wealth", async () => {
    const receipt = "SM1.pool::pool-token";
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith("/balances/stx")
        ? { balance: "0" }
        : { results: [{ asset_identifier: receipt, balance: "1" }], cursor: { next: null } },
    ), { status: 200 }));
    const positions = await new StacksApiAdapter(
      "https://example.test",
      request,
      undefined,
      async () => [],
      async () => [receipt],
    ).discover("SP000000000000000000002Q6VF78");
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ asset: { asset: "STX" } });
  });

  it("honors rate limiting and retries a bounded 429 response", async () => {
    let stxAttempts = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/balances/stx") && stxAttempts++ === 0) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }
      const payload = url.endsWith("/balances/stx")
        ? { balance: "123000000" }
        : url.includes("/balances/ft")
          ? { results: [], cursor: { next: null } }
          : { results: [{ height: 123 }] };
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    const positions = await new StacksApiAdapter("https://example.test", request).discover("SP000000000000000000002Q6VF78");
    expect(positions).toHaveLength(1);
    expect(stxAttempts).toBe(2);
    expect(request).toHaveBeenCalledTimes(4);
  });
});
