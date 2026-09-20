import { describe, expect, it, vi } from "vitest";
import { responseOkCV, stringAsciiCV, uintCV } from "@stacks/transactions";
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

  it("hydrates token metadata from the registry without claiming an unreconciled balance is verified", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith("/balances/stx")
        ? { balance: "0" }
        : { results: [{ asset_identifier: "SP123.token::asset", balance: "120000000" }], cursor: { next: null } },
    ), { status: 200 }));
    const positions = await new StacksApiAdapter("https://example.test", request, undefined, async () => [{
      assetIdentifier: "SP123.token::asset", symbol: "sBTC", decimals: 8, spendable: true,
    }]).discover("SP000000000000000000002Q6VF78");
    expect(positions[1]).toMatchObject({
      type: "wallet",
      asset: { asset: "sBTC", decimals: 8, assetIdentifier: "SP123.token::asset" },
      spendable: true,
      confidence: { state: "estimated" },
    });
  });

  it("shows an unregistered SIP-010 balance with on-chain symbol and decimals but withholds valuation support", async () => {
    const assetIdentifier = "SP123.token::susdh";
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith("/balances/stx")
        ? { balance: "0" }
        : { results: [{ asset_identifier: assetIdentifier, balance: "6387358450" }], cursor: { next: null } },
    ), { status: 200 }));
    const consensusClient = {
      pinTip: vi.fn(async () => ({
        blockHeight: 123,
        indexBlockHash: "0xabc",
        stxBalance: vi.fn(async () => 0n),
        call: vi.fn(async (_contract: string, functionName: string) => {
          if (functionName === "get-balance") return responseOkCV(uintCV(6387358450n));
          if (functionName === "get-decimals") return responseOkCV(uintCV(8));
          if (functionName === "get-symbol") return responseOkCV(stringAsciiCV("sUSDh"));
          throw new Error(`unexpected ${functionName}`);
        }),
      })),
    };
    const positions = await new StacksApiAdapter(
      "https://example.test",
      request,
      undefined,
      async () => [],
      async () => [],
      consensusClient as never,
    ).discover("SP000000000000000000002Q6VF78");
    expect(positions[1]).toMatchObject({
      type: "wallet",
      asset: { asset: "sUSDh", amountAtomic: "6387358450", decimals: 8, valueUsd: null },
      confidence: { state: "unsupported" },
    });
  });

  it("classifies a registry-approved Zest receipt held by the wallet as a supply position", async () => {
    const receipt = "SP123.vault::zft";
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith("/balances/stx")
        ? { balance: "0" }
        : { results: [{ asset_identifier: receipt, balance: "1397990673" }], cursor: { next: null } },
    ), { status: 200 }));
    const positions = await new StacksApiAdapter(
      "https://example.test",
      request,
      undefined,
      async () => [{
        assetIdentifier: receipt,
        symbol: "zstSTX",
        decimals: 6,
        spendable: true,
        positionType: "supply",
        protocol: { id: "zest", version: "mainnet", contract: "SP123.vault" },
      }],
    ).discover("SP000000000000000000002Q6VF78");
    expect(positions[1]).toMatchObject({
      type: "supply",
      protocol: { id: "zest" },
      asset: { asset: "zstSTX", amountAtomic: "1397990673", decimals: 6 },
    });
  });

  it("marks wallet balances verified only after pinned consensus reconciliation", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith("/balances/stx")
        ? { balance: "123000000" }
        : { results: [{ asset_identifier: "SP123.token::asset", balance: "120000000" }], cursor: { next: null } },
    ), { status: 200 }));
    const consensusClient = {
      pinTip: vi.fn(async () => ({
        blockHeight: 123,
        indexBlockHash: "0xabc",
        stxBalance: vi.fn(async () => 123000000n),
        call: vi.fn(async () => responseOkCV(uintCV(120000000))),
      })),
    };
    const positions = await new StacksApiAdapter(
      "https://example.test",
      request,
      undefined,
      async () => [{ assetIdentifier: "SP123.token::asset", symbol: "sBTC", decimals: 8, spendable: true }],
      async () => [],
      consensusClient as never,
    ).discover("SP000000000000000000002Q6VF78");
    expect(positions).toHaveLength(2);
    expect(positions[0]!.confidence.state).toBe("verified");
    expect(positions[1]!.confidence.state).toBe("verified");
  });

  it("reconciles spendable STX like-for-like and represents PoX-locked STX separately", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).endsWith("/balances/stx")
        ? { balance: "17956852696", available: "9956852696", locked: { amount: "8000000000" } }
        : { results: [], cursor: { next: null } },
    ), { status: 200 }));
    const consensusClient = {
      pinTip: vi.fn(async () => ({
        blockHeight: 123,
        indexBlockHash: "0xabc",
        stxBalance: vi.fn(async () => 9956852696n),
        call: vi.fn(),
      })),
    };

    const positions = await new StacksApiAdapter(
      "https://example.test",
      request,
      undefined,
      async () => [],
      async () => [],
      consensusClient as never,
    ).discover("SP000000000000000000002Q6VF78");

    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      id: expect.stringContaining(":stx"),
      spendable: true,
      asset: { amountAtomic: "9956852696" },
      confidence: { state: "verified" },
    });
    expect(positions[1]).toMatchObject({
      id: expect.stringContaining(":stx-locked"),
      spendable: false,
      asset: { amountAtomic: "8000000000" },
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
