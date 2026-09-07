import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";
import { atomicAmountToUsd, BitflowMarketPriceBook, DivergenceAwarePriceBook, enrichPositionsWithUsd, PythHermesPriceBook, resolvePriceUnderlying, ZestVaultExchangeRatePriceBook, type PriceBook } from "./index.js";
import type { Position } from "../../domain/src/index.js";
import type { StacksReadOnlyClient } from "../../adapters/src/stacks-read-only-client.js";

function book(prices: Record<string, string>): PriceBook {
  return {
    async quote(asset) {
      if (asset === "USDCx" || asset === "USDH" || asset === "USDC" || asset === "USDT") {
        return {
          asset, priceUsd: "1.00", source: "stablecoin-peg" as const, observedAt: "2026-09-04T00:00:00.000Z",
          ageSeconds: 0, confidence: 0.7, meaning: "peg",
        };
      }
      const underlying = resolvePriceUnderlying(asset);
      const priceUsd = prices[underlying] ?? prices[asset];
      if (!priceUsd) return null;
      return {
        asset, priceUsd, source: "dia" as const, observedAt: "2026-09-04T00:00:00.000Z",
        ageSeconds: 10, confidence: 0.9, meaning: `DIA ${asset}`,
      };
    },
  };
}

describe("pricing", () => {
  it("converts atomic amounts with fixed-point USD prices", () => {
    expect(atomicAmountToUsd("60000000", 8, "100000.00")).toBe("60000");
    expect(atomicAmountToUsd("45000000000", 6, "1.00")).toBe("45000");
  });

  it("maps Zest receipt / LST symbols onto underlying oracle assets", () => {
    expect(resolvePriceUnderlying("zstSTX")).toBe("STX");
    expect(resolvePriceUnderlying("stSTX")).toBe("STX");
    expect(resolvePriceUnderlying("zsBTC")).toBe("BTC");
  });

  it("enriches lending positions so risk/portfolio can compute health", async () => {
    const position: Position = {
      id: "zest-v2:lending:demo",
      type: "lending",
      protocol: { id: "zest", version: "v2", contract: "SP.demo" },
      collateral: { asset: "sBTC", amountAtomic: "60000000", decimals: 8, valueUsd: null },
      debt: { asset: "USDCx", amountAtomic: "45000000000", decimals: 6, valueUsd: null },
      parameters: { liquidationThresholdBps: 8000, maximumLtvBps: 7000 },
      provenance: [{ source: "contract-read", observedAt: "2026-09-04T00:00:00.000Z" }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const enriched = await enrichPositionsWithUsd([position], book({ BTC: "100000.00", STX: "2.00" }));
    expect(enriched.positions[0]).toMatchObject({
      type: "lending",
      collateral: { valueUsd: "60000" },
      debt: { valueUsd: "45000" },
    });
    expect(enriched.quotes.length).toBeGreaterThan(0);
  });

  it("values Zest stSTX / zstSTX positions via STX underlying", async () => {
    const position: Position = {
      id: "zest-v2:lending:lst",
      type: "lending",
      protocol: { id: "zest", version: "v2", contract: "SP.demo" },
      collateral: { asset: "zstSTX", amountAtomic: "100000000", decimals: 6, valueUsd: null },
      debt: { asset: "stSTX", amountAtomic: "40000000", decimals: 6, valueUsd: null },
      parameters: { liquidationThresholdBps: 8000, maximumLtvBps: 7000 },
      provenance: [{ source: "contract-read", observedAt: "2026-09-04T00:00:00.000Z" }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const enriched = await enrichPositionsWithUsd([position], book({ STX: "2.00" }));
    expect(enriched.positions[0]).toMatchObject({
      type: "lending",
      collateral: { valueUsd: "200" },
      debt: { valueUsd: "80" },
    });
    expect(enriched.warnings).toHaveLength(0);
  });

  it("uses the deployed Zest vault conversion instead of a 1:1 receipt-token alias", async () => {
    const vault = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-ststx";
    const underlying = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token";
    const client = {
      async pinTip() {
        return {
          blockHeight: 8_919_529,
          async call(contract: string, functionName: string) {
            if (contract === vault && functionName === "get-underlying") {
              return Cl.ok(Cl.contractPrincipal(...underlying.split(".") as [string, string]));
            }
            if (functionName === "get-decimals") return Cl.ok(Cl.uint(6));
            if (contract === vault && functionName === "convert-to-assets") return Cl.ok(Cl.uint(1_000_635));
            throw new Error(`Unexpected ${contract}.${functionName}`);
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    const registry = async () => ({
      version: "mainnet", network: "mainnet" as const, issuedAt: "2026-09-04T00:00:00.000Z", expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [{
        protocol: "zest-v2", adapterVersion: "mainnet", network: "mainnet" as const, contractPrincipal: vault,
        interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1, supportedAssets: [], assetDefinitions: [],
        readOnlyFunctions: ["convert-to-assets", "get-underlying", "get-decimals"], transactionFunctions: [],
        evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
      }],
    });
    const prices = new ZestVaultExchangeRatePriceBook(book({ STX: "2.00" }), client, registry);
    await expect(prices.quote("zstSTX")).resolves.toMatchObject({
      asset: "zstSTX", priceUsd: "2", source: "zest-vault", confidence: 0.9,
      meaning: expect.stringContaining("1.000635"),
    });
  });

  it("parses authenticated Pyth prices and preserves publication freshness", async () => {
    const now = new Date("2026-09-05T00:00:30.000Z");
    const publishTime = Math.floor(now.getTime() / 1_000) - 10;
    const pyth = new PythHermesPriceBook("token", "https://hermes.example", 60, async (_url, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
      return new Response(JSON.stringify({ parsed: [{
        id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
        price: { price: "7968101000000", expo: -8, publish_time: publishTime },
      }] }), { status: 200 });
    }, () => now);
    await expect(pyth.quote("BTC")).resolves.toMatchObject({
      priceUsd: "79681.01", source: "pyth", ageSeconds: 10, confidence: 0.92,
    });
  });

  it("fails closed when DIA and Pyth exceed the configured divergence", async () => {
    const dia = book({ BTC: "80000" });
    const farPyth: PriceBook = { async quote(asset) { return {
      asset, priceUsd: "76000", source: "pyth", observedAt: "2026-09-05T00:00:00.000Z",
      ageSeconds: 1, confidence: 0.92, meaning: "Pyth",
    }; } };
    await expect(new DivergenceAwarePriceBook(dia, farPyth, 150).quote("BTC")).resolves.toBeNull();
    const closePyth: PriceBook = { async quote(asset) { return {
      asset, priceUsd: "79920", source: "pyth", observedAt: "2026-09-05T00:00:00.000Z",
      ageSeconds: 1, confidence: 0.92, meaning: "Pyth",
    }; } };
    await expect(new DivergenceAwarePriceBook(dia, closePyth, 150).quote("BTC")).resolves.toMatchObject({
      source: "dia-pyth-consensus", priceUsd: "79960", confidence: 0.9,
    });
    await expect(new DivergenceAwarePriceBook(dia, closePyth, 150).quote("USDCx")).resolves.toMatchObject({
      source: "stablecoin-peg", priceUsd: "1.00",
    });
  });

  it("prices USDCx from a registry-approved Bitflow active bin and rejects a depeg", async () => {
    const poolContract = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
    const registry = async () => ({
      version: "2026-09-05.1", network: "mainnet" as const, issuedAt: "2026-09-05T00:00:00.000Z", expiresAt: "2027-09-05T00:00:00.000Z",
      entries: [{
        protocol: "bitflow", adapterVersion: "mainnet", network: "mainnet" as const, contractPrincipal: poolContract,
        interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1, supportedAssets: ["sBTC", "USDCx"], assetDefinitions: [],
        readOnlyFunctions: [], transactionFunctions: [], evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
      }],
    });
    const request = async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("/v1/pools?") ? {
      data: [{ poolId: "dlmm_1", poolContract, tokens: { tokenX: { symbol: "sBTC" }, tokenY: { symbol: "USDCx" } } }],
    } : { success: true, price: "80000000000", applied_block_height: 900 }), { status: 200 });
    const prices = new BitflowMarketPriceBook(book({ BTC: "80000" }), registry, "https://app.test", "https://quotes.test", 500, request, () => new Date("2026-09-05T00:00:00.000Z"));
    await expect(prices.quote("USDCx")).resolves.toMatchObject({
      asset: "USDCx", priceUsd: "1", source: "bitflow-market", confidence: 0.88,
      meaning: expect.stringContaining("block 900"),
    });

    const depegRequest = async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("/v1/pools?") ? {
      data: [{ poolId: "dlmm_1", poolContract, tokens: { tokenX: { symbol: "sBTC" }, tokenY: { symbol: "USDCx" } } }],
    } : { success: true, price: "70000000000", applied_block_height: 900 }), { status: 200 });
    await expect(new BitflowMarketPriceBook(book({ BTC: "80000" }), registry, "https://app.test", "https://quotes.test", 500, depegRequest).quote("USDCx"))
      .resolves.toBeNull();
  });

  it("refuses fixture-source quotes during enrichment", async () => {
    const fixtureBook: PriceBook = {
      async quote(asset) {
        return {
          asset, priceUsd: "1.00", source: "fixture", observedAt: "2026-09-04T00:00:00.000Z",
          ageSeconds: null, confidence: 0.1, meaning: "fixture",
        };
      },
    };
    const position: Position = {
      id: "wallet:stx", type: "wallet", protocol: { id: "stacks", version: "v1" },
      asset: { asset: "STX", amountAtomic: "1000000", decimals: 6, valueUsd: null },
      spendable: true,
      provenance: [{ source: "stacks-api", observedAt: "2026-09-04T00:00:00.000Z" }],
      confidence: { state: "estimated", score: 0.5, reasons: [] },
    };
    const enriched = await enrichPositionsWithUsd([position], fixtureBook);
    expect(enriched.positions[0]).toMatchObject({ asset: { valueUsd: null } });
    expect(enriched.warnings.some((warning) => /Refusing fixture/.test(warning))).toBe(true);
  });
});
