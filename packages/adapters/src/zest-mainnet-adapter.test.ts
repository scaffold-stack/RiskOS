import {
  bufferCV,
  cvToHex,
  listCV,
  principalCV,
  responseErrorCV,
  responseOkCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { registryManifestSchema } from "../../data-foundation/src/registry.js";
import { StacksReadOnlyClient } from "./stacks-read-only-client.js";
import { ZestMainnetAdapter } from "./zest-mainnet-adapter.js";

const deployer = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";

function manifest() {
  const names = [
    "v0-8-market",
    "v0-market-vault",
    "v0-assets",
    "v0-egroup",
    "v0-vault-stx",
    "v0-vault-sbtc",
    "v0-vault-ststx",
  ];
  return registryManifestSchema.parse({
    version: "2026-09-04.1",
    network: "mainnet",
    issuedAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2026-10-04T00:00:00.000Z",
    entries: names.map((name) => ({
      protocol: "zest-v2",
      adapterVersion: "zest-v2-v0.8-readonly-2026-09",
      network: "mainnet",
      contractPrincipal: `${deployer}.${name}`,
      interfaceHash: `sha256:${"a".repeat(64)}`,
      activationBlock: 1,
      supportedAssets: [],
      readOnlyFunctions:
        name === "v0-market-vault"
          ? ["get-position"]
          : name === "v0-assets"
            ? ["get-bitmap", "get-status"]
            : name === "v0-egroup"
              ? ["resolve"]
              : name.startsWith("v0-vault-")
                ? ["get-next-index", "get-interest-rate", "get-utilization", "get-fee-reserve"]
                : [],
      transactionFunctions: [],
      evidenceUrls: ["https://zest.example/deployment", "https://explorer.example/contract"],
      enabled: true,
    })),
  });
}

describe("ZestMainnetAdapter", () => {
  it("treats the deployed ERR-UNTRACKED-ACCOUNT response as no position", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/extended/v2/blocks?limit=1")) {
        return new Response(
          JSON.stringify({
            results: [{ canonical: true, height: 900, index_block_hash: `0x${"b".repeat(64)}` }],
          }),
          { status: 200 },
        );
      }
      const functionName = new URL(url).pathname.split("/").at(-1);
      const result = functionName === "get-bitmap" ? uintCV(12) : responseErrorCV(uintCV(600_006));
      return new Response(JSON.stringify({ okay: true, result: cvToHex(result) }), { status: 200 });
    });
    const adapter = new ZestMainnetAdapter(
      async () => manifest(),
      new StacksReadOnlyClient("https://stacks.test", request),
    );
    await expect(adapter.discover("SP000000000000000000002Q6VF78")).resolves.toEqual([]);
  });

  it("keeps unknown Zest response errors fail-closed", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/extended/v2/blocks?limit=1")) {
        return new Response(
          JSON.stringify({
            results: [{ canonical: true, height: 900, index_block_hash: `0x${"b".repeat(64)}` }],
          }),
          { status: 200 },
        );
      }
      const functionName = new URL(url).pathname.split("/").at(-1);
      const result = functionName === "get-bitmap" ? uintCV(12) : responseErrorCV(uintCV(600_002));
      return new Response(JSON.stringify({ okay: true, result: cvToHex(result) }), { status: 200 });
    });
    const adapter = new ZestMainnetAdapter(
      async () => manifest(),
      new StacksReadOnlyClient("https://stacks.test", request),
    );
    await expect(adapter.discover("SP000000000000000000002Q6VF78")).rejects.toThrow("err u600002");
  });

  it("normalizes a supply balance and derives the current APR from pinned vault inputs", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/extended/v2/blocks?limit=1")) {
        return new Response(
          JSON.stringify({
            results: [{ canonical: true, height: 900, index_block_hash: `0x${"b".repeat(64)}` }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v2/contracts/interface/")) {
        return new Response(JSON.stringify({ fungible_tokens: [] }), { status: 200 });
      }
      const functionName = new URL(url).pathname.split("/").at(-1);
      let result;
      if (functionName === "get-bitmap") result = uintCV(32);
      else if (functionName === "get-position")
        result = responseOkCV(
          tupleCV({
            account: principalCV("SP000000000000000000002Q6VF78"),
            id: uintCV(1195),
            lastBorrowBlock: uintCV(800),
            lastUpdate: uintCV(1),
            mask: uintCV(32),
            collateral: listCV([tupleCV({ aid: uintCV(5), amount: uintCV(2_016_210_567) })]),
            debt: listCV([]),
          }),
        );
      else if (functionName === "get-status")
        result = responseOkCV(
          tupleCV({
            addr: principalCV(`${deployer}.v0-vault-ststx`),
            collateral: uintCV(1),
            debt: uintCV(0),
            decimals: uintCV(6),
            id: uintCV(5),
            oracle: tupleCV({}),
          }),
        );
      else if (functionName === "get-interest-rate") result = responseOkCV(uintCV(500));
      else if (functionName === "get-utilization") result = responseOkCV(uintCV(8_000));
      else if (functionName === "get-fee-reserve") result = responseOkCV(uintCV(1_000));
      else throw new Error(`Unexpected call ${functionName}`);
      return new Response(JSON.stringify({ okay: true, result: cvToHex(result) }), { status: 200 });
    });
    const adapter = new ZestMainnetAdapter(
      async () => manifest(),
      new StacksReadOnlyClient("https://stacks.test", request),
    );
    const positions = await adapter.discover("SP000000000000000000002Q6VF78");
    expect(positions).toEqual([
      expect.objectContaining({
        type: "supply",
        asset: expect.objectContaining({ asset: "zstSTX", amountAtomic: "2016210567", decimals: 6 }),
      }),
    ]);
    expect((positions[0] as { asset: unknown }).asset).not.toHaveProperty("assetIdentifier");
    expect(positions[0]).toMatchObject({
      type: "supply",
      asset: expect.objectContaining({ asset: "zstSTX" }),
    });
    expect(positions[0]).not.toHaveProperty("earnings");
    expect(positions[0]).not.toHaveProperty("rates");
  });

  it("reads a position and hydrates scaled debt and egroup thresholds at one pinned tip", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/extended/v2/blocks?limit=1")) {
        return new Response(
          JSON.stringify({
            results: [{ canonical: true, height: 900, index_block_hash: `0x${"b".repeat(64)}` }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v2/contracts/interface/")) {
        return new Response(JSON.stringify({ fungible_tokens: [] }), { status: 200 });
      }
      const functionName = new URL(url).pathname.split("/").at(-1);
      const args = JSON.parse(String(init?.body ?? "{}")) as { arguments: string[] };
      let result;
      if (functionName === "get-bitmap") result = uintCV(12);
      else if (functionName === "get-position")
        result = responseOkCV(
          tupleCV({
            account: principalCV("SP000000000000000000002Q6VF78"),
            id: uintCV(7),
            lastBorrowBlock: uintCV(800),
            lastUpdate: uintCV(1),
            mask: uintCV(12),
            collateral: listCV([tupleCV({ aid: uintCV(3), amount: uintCV(500_000_000) })]),
            debt: listCV([tupleCV({ aid: uintCV(0), scaled: uintCV(100_000_000) })]),
          }),
        );
      else if (functionName === "get-status") {
        const isDebt = args.arguments[0]?.endsWith("00");
        result = responseOkCV(
          tupleCV({
            addr: principalCV(
              isDebt ? `${deployer}.wstx` : `${deployer}.v0-vault-sbtc`,
            ),
            collateral: uintCV(0),
            debt: uintCV(0),
            decimals: uintCV(isDebt ? 6 : 8),
            id: uintCV(isDebt ? 0 : 3),
            oracle: tupleCV({}),
          }),
        );
      } else if (functionName === "resolve")
        result = responseOkCV(
          tupleCV({
            "LTV-LIQ-PARTIAL": bufferCV(new Uint8Array([0x1f, 0x40])),
            "LTV-BORROW": bufferCV(new Uint8Array([0x1b, 0x58])),
          }),
        );
      else if (functionName === "get-next-index") result = responseOkCV(uintCV(1_100_000_000_000n));
      else if (functionName === "get-interest-rate") result = responseOkCV(uintCV(269));
      else if (functionName === "get-utilization") result = responseOkCV(uintCV(7_500));
      else if (functionName === "get-fee-reserve") result = responseOkCV(uintCV(1_000));
      else throw new Error(`Unexpected call ${functionName}`);
      return new Response(JSON.stringify({ okay: true, result: cvToHex(result) }), { status: 200 });
    });
    const adapter = new ZestMainnetAdapter(
      async () => manifest(),
      new StacksReadOnlyClient("https://stacks.test", request),
    );
    const positions = await adapter.discover("SP000000000000000000002Q6VF78");
    expect(positions).toEqual([
      expect.objectContaining({
        type: "lending",
        collateral: expect.objectContaining({ asset: "zsBTC", amountAtomic: "500000000", decimals: 8 }),
        debt: expect.objectContaining({
          asset: "STX",
          amountAtomic: "110000000",
          decimals: 6,
          protocolAssetId: 0,
          contractPrincipal: `${deployer}.wstx`,
        }),
        legs: {
          collateral: [expect.objectContaining({ asset: "zsBTC" })],
          debt: [expect.objectContaining({ asset: "STX" })],
        },
        parameters: { liquidationThresholdBps: 8000, maximumLtvBps: 7000 },
        rates: expect.objectContaining({
          borrowAprBps: 269,
          supplyAprBps: 181,
          utilizationBps: 7500,
          reserveFactorBps: 1000,
        }),
        provenance: [expect.objectContaining({ source: "contract-read", blockHeight: 900 })],
      }),
    ]);
    expect((positions[0] as { debt: unknown }).debt).not.toHaveProperty("assetIdentifier");
    expect(positions[0]).toHaveProperty("rates.debtProjections", [
      expect.objectContaining({ days: 7 }),
      expect.objectContaining({ days: 30 }),
      expect.objectContaining({ days: 90 }),
    ]);
    expect(
      request.mock.calls
        .filter(([url]) => String(url).includes("call-read"))
        .every(([url]) => String(url).includes(`tip=0x${"b".repeat(64)}`)),
    ).toBe(true);
  });
});
