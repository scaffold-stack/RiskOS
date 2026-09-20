import { describe, expect, it, vi } from "vitest";
import { Cl } from "@stacks/transactions";
import {
  atomicAmountToUsd,
  BitflowMarketPriceBook,
  BitflowStablecoinMarketPriceBook,
  CoinGeckoPriceBook,
  CoinbaseExchangePriceBook,
  CompositePriceBook,
  DivergenceAwarePriceBook,
  enrichPositionsWithUsd,
  GraniteExchangeRatePriceBook,
  HermeticaExchangeRatePriceBook,
  PythHermesPriceBook,
  ProtocolStablecoinConsensusPriceBook,
  QuorumPriceBook,
  resolvePriceUnderlying,
  StackingDaoExchangeRatePriceBook,
  ZestVaultExchangeRatePriceBook,
  type PriceBook,
} from "./index.js";
import type { Position } from "../../domain/src/index.js";
import type { StacksReadOnlyClient } from "../../adapters/src/stacks-read-only-client.js";

function book(prices: Record<string, string>): PriceBook {
  return {
    async quote(asset) {
      const observedAt = new Date().toISOString();
      if (asset === "USDCx" || asset === "USDH" || asset === "USDC" || asset === "USDT") {
        const priceUsd = prices[asset];
        return priceUsd
          ? {
              asset,
              priceUsd,
              source: "bitflow-market" as const,
              observedAt,
              ageSeconds: 0,
              confidence: 0.88,
              meaning: "market-observed stablecoin price",
            }
          : null;
      }
      const underlying = resolvePriceUnderlying(asset);
      const priceUsd = prices[underlying] ?? prices[asset];
      if (!priceUsd) return null;
      return {
        asset,
        priceUsd,
        source: "dia" as const,
        observedAt,
        ageSeconds: 10,
        confidence: 0.9,
        meaning: `DIA ${asset}`,
      };
    },
  };
}

describe("pricing", () => {
  it("converts atomic amounts with fixed-point USD prices", () => {
    expect(atomicAmountToUsd("60000000", 8, "100000.00")).toBe("60000");
    expect(atomicAmountToUsd("45000000000", 6, "1.00")).toBe("45000");
  });

  it("does not assume receipt-token or LST parity", () => {
    expect(resolvePriceUnderlying("zstSTX")).toBe("zstSTX");
    expect(resolvePriceUnderlying("stSTX")).toBe("stSTX");
    expect(resolvePriceUnderlying("zsBTC")).toBe("zsBTC");
    expect(resolvePriceUnderlying("sBTC")).toBe("BTC");
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
    const enriched = await enrichPositionsWithUsd(
      [position],
      book({ BTC: "100000.00", STX: "2.00", USDCx: "1.00" }),
    );
    expect(enriched.positions[0]).toMatchObject({
      type: "lending",
      collateral: { valueUsd: "60000" },
      debt: { valueUsd: "45000" },
    });
    expect(enriched.quotes.length).toBeGreaterThan(0);
  });

  it("keeps a primary debt leg's USD value distinct from the multi-debt basket total", async () => {
    const position: Position = {
      id: "zest-v2:lending:multi-debt",
      type: "lending",
      protocol: { id: "zest", version: "v2", contract: "SP.demo" },
      collateral: { asset: "sBTC", amountAtomic: "100000000", decimals: 8, valueUsd: null },
      debt: { asset: "stSTX", amountAtomic: "2000000", decimals: 6, valueUsd: null },
      legs: {
        collateral: [{ asset: "sBTC", amountAtomic: "100000000", decimals: 8, valueUsd: null }],
        debt: [
          { asset: "stSTX", amountAtomic: "2000000", decimals: 6, valueUsd: null },
          { asset: "USDCx", amountAtomic: "3000000", decimals: 6, valueUsd: null },
        ],
      },
      parameters: { liquidationThresholdBps: 8000, maximumLtvBps: 7000 },
      provenance: [{ source: "contract-read", observedAt: "2026-09-04T00:00:00.000Z" }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const enriched = await enrichPositionsWithUsd(
      [position],
      book({ BTC: "100000", stSTX: "0.50", USDCx: "1.00" }),
    );
    const lending = enriched.positions[0];
    expect(lending).toMatchObject({
      type: "lending",
      debt: { asset: "stSTX", valueUsd: "1" },
      legs: { debt: [{ asset: "stSTX", valueUsd: "1" }, { asset: "USDCx", valueUsd: "3" }] },
    });
  });

  it("leaves LST positions unvalued without a conversion source", async () => {
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
      collateral: { valueUsd: null },
      debt: { valueUsd: null },
    });
    expect(enriched.warnings).toEqual(
      expect.arrayContaining(["No USD quote for collateral zstSTX", "No USD quote for debt stSTX"]),
    );
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
              return Cl.ok(Cl.contractPrincipal(...(underlying.split(".") as [string, string])));
            }
            if (functionName === "get-decimals") return Cl.ok(Cl.uint(6));
            if (contract === vault && functionName === "convert-to-assets") return Cl.ok(Cl.uint(1_000_635));
            throw new Error(`Unexpected ${contract}.${functionName}`);
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    const registry = async () => ({
      version: "mainnet",
      network: "mainnet" as const,
      issuedAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [
        {
          protocol: "zest-v2",
          adapterVersion: "mainnet",
          network: "mainnet" as const,
          contractPrincipal: vault,
          interfaceHash: `sha256:${"a".repeat(64)}`,
          activationBlock: 1,
          supportedAssets: [],
          assetDefinitions: [],
          readOnlyFunctions: ["convert-to-assets", "get-underlying", "get-decimals"],
          transactionFunctions: [],
          evidenceUrls: ["https://example.com/a", "https://example.com/b"],
          enabled: true,
        },
      ],
    });
    const prices = new ZestVaultExchangeRatePriceBook(book({ stSTX: "2.00" }), client, registry);
    await expect(prices.quote("zstSTX")).resolves.toMatchObject({
      asset: "zstSTX",
      priceUsd: "2.00127",
      source: "zest-vault",
      confidence: 0.9,
      meaning: expect.stringContaining("1.000635"),
    });
  });

  it("values zvstBTC through its strategy engine rather than the lending vault", async () => {
    const token = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zvstBTC::zvstbtc";
    const engine = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zv-engine-stbtc-0";
    const client = {
      async pinTip() {
        return {
          blockHeight: 9_000_000,
          async call(contract: string, functionName: string) {
            expect(contract).toBe(engine);
            expect(functionName).toBe("convert-to-assets");
            return Cl.ok(Cl.uint(101_250_000));
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    const registry = async () => ({
      version: "mainnet",
      network: "mainnet" as const,
      issuedAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [{
        protocol: "zest-v2",
        adapterVersion: "mainnet",
        network: "mainnet" as const,
        contractPrincipal: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-assets",
        interfaceHash: `sha256:${"a".repeat(64)}`,
        activationBlock: 1,
        supportedAssets: ["zvstBTC"],
        assetDefinitions: [{ assetIdentifier: token, symbol: "zvstBTC", decimals: 8, spendable: true }],
        readOnlyFunctions: [],
        transactionFunctions: [],
        evidenceUrls: ["https://example.com/a", "https://example.com/b"],
        enabled: true,
      }],
    });
    const prices = new ZestVaultExchangeRatePriceBook(book({ stBTC: "80000" }), client, registry);

    await expect(prices.quote("zvstBTC")).resolves.toMatchObject({
      asset: "zvstBTC",
      priceUsd: "81000",
      source: "zest-vault",
      meaning: expect.stringContaining("1.0125 stBTC"),
    });
  });

  it("values stSTX from the registry-approved StackingDAO exchange rate", async () => {
    const rateContract = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.data-stx-v2";
    const client = {
      async pinTip() {
        return {
          blockHeight: 8_931_500,
          async call(contract: string, functionName: string) {
            expect(contract).toBe(rateContract);
            expect(functionName).toBe("get-stx-per-ststx");
            return Cl.uint(1_250_000);
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    const registry = async () => ({
      version: "mainnet",
      network: "mainnet" as const,
      issuedAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [
        {
          protocol: "stackingdao",
          adapterVersion: "mainnet",
          network: "mainnet" as const,
          contractPrincipal: rateContract,
          interfaceHash: `sha256:${"a".repeat(64)}`,
          activationBlock: 1,
          supportedAssets: ["stSTX"],
          assetDefinitions: [],
          readOnlyFunctions: ["get-stx-per-ststx"],
          transactionFunctions: [],
          evidenceUrls: ["https://example.com/a", "https://example.com/b"],
          enabled: true,
        },
      ],
    });
    const prices = new StackingDaoExchangeRatePriceBook(book({ STX: "2.00" }), client, registry);
    await expect(prices.quote("stSTX")).resolves.toMatchObject({
      asset: "stSTX",
      priceUsd: "2.5",
      source: "stackingdao-rate",
      confidence: 0.9,
      meaning: expect.stringContaining("1.25 STX"),
    });
  });

  it("values stSTXbtc from its deployed 1:1 STX backing without inventing a market rate", async () => {
    const client = {
      async pinTip() {
        throw new Error("stSTXbtc must not use the appreciating stSTX rate contract");
      },
    } as unknown as StacksReadOnlyClient;
    const prices = new StackingDaoExchangeRatePriceBook(
      book({ STX: "0.275" }),
      client,
      async () => null,
    );

    await expect(prices.quote("stSTXbtc")).resolves.toMatchObject({
      asset: "stSTXbtc",
      priceUsd: "0.275",
      source: "stackingdao-rate",
      confidence: 0.9,
      meaning: expect.stringContaining("protocol backing"),
    });
  });

  it("values stBTC from the registry-approved live sBTC-per-stBTC backing ratio", async () => {
    const rateContract = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.data-stbtc-v1";
    const client = {
      async pinTip() {
        return {
          blockHeight: 8_949_500,
          async call(contract: string, functionName: string) {
            expect(contract).toBe(rateContract);
            expect(functionName).toBe("get-sbtc-per-stbtc");
            return Cl.uint(101_250_000);
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    const registry = async () => ({
      version: "mainnet",
      network: "mainnet" as const,
      issuedAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [{
        protocol: "stackingdao",
        adapterVersion: "mainnet",
        network: "mainnet" as const,
        contractPrincipal: rateContract,
        interfaceHash: `sha256:${"a".repeat(64)}`,
        activationBlock: 1,
        supportedAssets: ["stBTC"],
        assetDefinitions: [],
        readOnlyFunctions: ["get-sbtc-per-stbtc"],
        transactionFunctions: [],
        evidenceUrls: ["https://example.com/a", "https://example.com/b"],
        enabled: true,
      }],
    });
    const prices = new StackingDaoExchangeRatePriceBook(book({ BTC: "80000" }), client, registry);

    await expect(prices.quote("stBTC")).resolves.toMatchObject({
      asset: "stBTC",
      priceUsd: "81000",
      source: "stackingdao-rate",
      confidence: 0.9,
      meaning: expect.stringContaining("1.0125 sBTC"),
    });
  });

  it("values sUSDh through the verified Hermetica exchange rate rather than assuming parity", async () => {
    const staking = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-v1-1";
    const client = {
      async pinTip() {
        return {
          blockHeight: 8_952_308,
          async call(contract: string, functionName: string) {
            expect(contract).toBe(staking);
            expect(functionName).toBe("get-usdh-per-susdh");
            return Cl.ok(Cl.uint(126_168_142));
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    const registry = async () => ({
      version: "mainnet", network: "mainnet" as const,
      issuedAt: "2026-09-04T00:00:00.000Z", expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [{
        protocol: "hermetica", adapterVersion: "mainnet", network: "mainnet" as const,
        contractPrincipal: staking, interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1,
        supportedAssets: ["USDH", "sUSDh"], assetDefinitions: [],
        readOnlyFunctions: ["get-usdh-per-susdh"], transactionFunctions: [],
        evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
      }],
    });
    const prices = new HermeticaExchangeRatePriceBook(book({ USDH: "0.99921544" }), client, registry);

    await expect(prices.quote("sUSDh")).resolves.toMatchObject({
      asset: "sUSDh",
      priceUsd: "1.26069155",
      source: "hermetica-rate",
      meaning: expect.stringContaining("1.26168142 USDh"),
    });
  });

  it("values Granite gUSDC with the deployed share conversion rather than assuming one dollar", async () => {
    const state = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1";
    const client = {
      async pinTip() {
        return {
          blockHeight: 8_952_308,
          async call(contract: string, functionName: string) {
            expect(contract).toBe(state);
            expect(functionName).toBe("convert-to-assets");
            return Cl.uint(1_032_961);
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    const registry = async () => ({
      version: "mainnet", network: "mainnet" as const,
      issuedAt: "2026-09-04T00:00:00.000Z", expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [{
        protocol: "granite", adapterVersion: "mainnet", network: "mainnet" as const,
        contractPrincipal: state, interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1,
        supportedAssets: ["gUSDC"], assetDefinitions: [], readOnlyFunctions: ["convert-to-assets"],
        transactionFunctions: [], evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
      }],
    });
    const prices = new GraniteExchangeRatePriceBook(book({ aeUSDC: "1.0005" }), client, registry);

    await expect(prices.quote("gUSDC")).resolves.toMatchObject({
      asset: "gUSDC",
      priceUsd: "1.03347748",
      source: "granite-rate",
      meaning: expect.stringContaining("1.032961 aeUSDC"),
    });
  });

  it("requires independent agreement before accepting a protocol stablecoin price", async () => {
    const market = book({ USDH: "0.998" });
    const independent = book({ USDH: "1.001" });
    const prices = new ProtocolStablecoinConsensusPriceBook(book({}), market, independent, book({ USDC: "1" }), 50);
    await expect(prices.quote("USDH")).resolves.toMatchObject({
      source: "multi-source-consensus",
      priceUsd: "0.9995",
    });

    const divergent = new ProtocolStablecoinConsensusPriceBook(
      book({}), book({ USDH: "0.96" }), independent, book({ USDC: "1" }), 150,
    );
    await expect(divergent.quote("USDH")).resolves.toBeNull();
  });

  it("derives USDh market value only from a registry-approved Bitflow pool against verified USDCx", async () => {
    const usdh = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1";
    const usdcx = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
    const pool = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1";
    const registry = async () => ({
      version: "mainnet", network: "mainnet" as const,
      issuedAt: "2026-09-04T00:00:00.000Z", expiresAt: "2027-09-04T00:00:00.000Z",
      entries: [
        {
          protocol: "hermetica", adapterVersion: "mainnet", network: "mainnet" as const,
          contractPrincipal: usdh, interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1,
          supportedAssets: ["USDH"], assetDefinitions: [{ assetIdentifier: `${usdh}::usdh`, symbol: "USDH", decimals: 8, spendable: true }],
          readOnlyFunctions: [], transactionFunctions: [], evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
        },
        {
          protocol: "usdcx", adapterVersion: "mainnet", network: "mainnet" as const,
          contractPrincipal: usdcx, interfaceHash: `sha256:${"b".repeat(64)}`, activationBlock: 1,
          supportedAssets: ["USDCx"], assetDefinitions: [{ assetIdentifier: `${usdcx}::usdcx-token`, symbol: "USDCx", decimals: 6, spendable: true }],
          readOnlyFunctions: [], transactionFunctions: [], evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
        },
        {
          protocol: "bitflow", adapterVersion: "mainnet", network: "mainnet" as const,
          contractPrincipal: pool, interfaceHash: `sha256:${"c".repeat(64)}`, activationBlock: 1,
          supportedAssets: ["USDH", "USDCx"], assetDefinitions: [], readOnlyFunctions: [], transactionFunctions: [],
          evidenceUrls: ["https://example.com/a", "https://example.com/b"], enabled: true,
        },
      ],
    });
    const request = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/pools")) return new Response(JSON.stringify({ pools: [{ pool_id: "dlmm_8", pool_token: pool, token_x: usdh, token_y: usdcx }] }), { status: 200 });
      if (url.endsWith("/v1/bins/dlmm_8/active")) return new Response(JSON.stringify({ success: true, price: "999000", applied_block_height: 8_952_308 }), { status: 200 });
      throw new Error(`Unexpected ${url}`);
    };
    const prices = new BitflowStablecoinMarketPriceBook(
      book({ USDCx: "1.0002" }), registry, "https://bitflow.example", request as typeof fetch,
    );

    await expect(prices.quote("USDH")).resolves.toMatchObject({
      asset: "USDH",
      priceUsd: "0.9991998",
      source: "bitflow-market",
      meaning: expect.stringContaining("dlmm_8"),
    });
  });

  it("parses authenticated Pyth prices and preserves publication freshness", async () => {
    const now = new Date("2026-09-05T00:00:30.000Z");
    const publishTime = Math.floor(now.getTime() / 1_000) - 10;
    const pyth = new PythHermesPriceBook(
      "token",
      "https://hermes.example",
      60,
      async (_url, init) => {
        expect(init?.headers).toMatchObject({ authorization: "Bearer token" });
        return new Response(
          JSON.stringify({
            parsed: [
              {
                id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
                price: { price: "7968101000000", expo: -8, publish_time: publishTime },
              },
            ],
          }),
          { status: 200 },
        );
      },
      () => now,
    );
    await expect(pyth.quote("BTC")).resolves.toMatchObject({
      priceUsd: "79681.01",
      source: "pyth",
      ageSeconds: 10,
      confidence: 0.92,
    });
  });

  it("treats denied Pyth entitlements as unavailable instead of hard failures", async () => {
    const pyth = new PythHermesPriceBook(
      "token",
      "https://hermes.example",
      60,
      async () => new Response("not entitled", { status: 403 }),
    );
    await expect(pyth.quote("STX")).resolves.toBeNull();
  });

  it("uses a fresh fixed-ID CoinGecko market as the independent fallback when Pyth denies STX", async () => {
    const now = new Date("2026-09-08T10:00:30.000Z");
    const coinGecko = new CoinGeckoPriceBook(
      "https://api.coingecko.test/api/v3",
      undefined,
      120,
      async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("ids")).toBe("bitcoin,blockstack");
        expect(url.searchParams.get("include_last_updated_at")).toBe("true");
        return new Response(JSON.stringify({
          blockstack: { usd: 0.268, last_updated_at: Math.floor(now.getTime() / 1_000) - 10 },
        }), { status: 200 });
      },
      () => now,
    );
    const deniedPyth: PriceBook = { async quote() { throw new Error("not entitled"); } };
    const reference = new CompositePriceBook(deniedPyth, coinGecko);
    const dia: PriceBook = {
      async quote(asset) {
        return {
          asset,
          priceUsd: "0.267",
          source: "dia",
          observedAt: "2026-09-08T10:00:20.000Z",
          ageSeconds: 10,
          confidence: 0.9,
          meaning: "DIA STX/USD",
        };
      },
    };

    await expect(new DivergenceAwarePriceBook(dia, reference, 150).quote("STX")).resolves.toMatchObject({
      source: "multi-source-consensus",
      priceUsd: "0.2675",
      confidence: 0.88,
      meaning: expect.stringContaining("DIA and CoinGecko independently reported prices"),
    });
  });

  it("reads a fresh fixed-ID Coinbase STX-USD market for quorum use", async () => {
    const now = new Date("2026-09-09T09:00:30.000Z");
    const prices = new CoinbaseExchangePriceBook(
      "https://coinbase.example",
      120,
      async (input) => {
        expect(String(input)).toBe("https://coinbase.example/products/STX-USD/ticker");
        return new Response(JSON.stringify({ price: "0.271", time: "2026-09-09T09:00:00.000Z" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      () => now,
    );
    await expect(prices.quote("STX")).resolves.toMatchObject({
      asset: "STX",
      priceUsd: "0.271",
      source: "coinbase",
      ageSeconds: 30,
      confidence: 0.88,
    });
  });

  it("marks stale CoinGecko observations below the accepted valuation confidence", async () => {
    const now = new Date("2026-09-08T10:10:00.000Z");
    const prices = new CoinGeckoPriceBook(
      "https://api.coingecko.test/api/v3",
      "demo-key",
      120,
      async (_input, init) => {
        expect(init?.headers).toMatchObject({ "x-cg-demo-api-key": "demo-key" });
        return new Response(JSON.stringify({
          bitcoin: { usd: 78_000, last_updated_at: Math.floor(now.getTime() / 1_000) - 300 },
        }), { status: 200 });
      },
      () => now,
    );
    await expect(prices.quote("BTC")).resolves.toMatchObject({
      source: "coingecko",
      ageSeconds: 300,
      confidence: 0.4,
    });
  });

  it("falls back when an entitled Pyth feed is stale instead of propagating a low-confidence quote", async () => {
    const stalePyth: PriceBook = {
      async quote(asset) {
        return {
          asset,
          priceUsd: "78000",
          source: "pyth",
          observedAt: "2026-09-08T09:00:00.000Z",
          ageSeconds: 300,
          confidence: 0.4,
          meaning: "stale Pyth",
        };
      },
    };
    const freshReference: PriceBook = {
      async quote(asset) {
        return {
          asset,
          priceUsd: "78100",
          source: "coingecko",
          observedAt: "2026-09-08T10:00:00.000Z",
          ageSeconds: 10,
          confidence: 0.88,
          meaning: "fresh CoinGecko",
        };
      },
    };
    await expect(new CompositePriceBook(stalePyth, freshReference).quote("BTC")).resolves.toMatchObject({
      source: "coingecko",
      priceUsd: "78100",
    });
  });

  it("accepts a two-source quorum when a third provider is an outlier", async () => {
    const quote = (source: "dia" | "pyth" | "coingecko", priceUsd: string): PriceBook => ({
      async quote(asset) {
        return {
          asset,
          priceUsd,
          source,
          observedAt: "2026-09-08T10:00:00.000Z",
          ageSeconds: 10,
          confidence: 0.9,
          meaning: `${source} evidence`,
        };
      },
    });
    const quorum = new QuorumPriceBook([
      quote("dia", "0.267"),
      quote("pyth", "0.31"),
      quote("coingecko", "0.268"),
    ], 2, 150);

    await expect(quorum.quote("STX")).resolves.toMatchObject({
      source: "multi-source-consensus",
      priceUsd: "0.2675",
      confidence: 0.9,
      meaning: expect.stringMatching(/2-of-3.*dia \+ coingecko.*Excluded outlier\(s\): pyth/),
    });
  });

  it("coalesces BTC aliases into one market-quorum read", async () => {
    let sourceCalls = 0;
    const source = (name: "dia" | "coingecko", priceUsd: string): PriceBook => ({
      async quote(asset) {
        sourceCalls += 1;
        await Promise.resolve();
        return {
          asset,
          priceUsd,
          source: name,
          observedAt: "2026-09-08T10:00:00.000Z",
          ageSeconds: 10,
          confidence: 0.9,
          meaning: `${name} evidence`,
        };
      },
    });
    const quorum = new QuorumPriceBook([
      source("dia", "80000"),
      source("coingecko", "80010"),
    ]);

    const [btc, sbtc] = await Promise.all([quorum.quote("BTC"), quorum.quote("sBTC")]);

    expect(sourceCalls).toBe(2);
    expect(btc).toMatchObject({ asset: "BTC", priceUsd: "80005" });
    expect(sbtc).toMatchObject({ asset: "sBTC", priceUsd: "80005", confidence: 0.75 });
  });

  it("evaluates every position against one pinned valuation instant", async () => {
    const startedAt = new Date("2026-09-11T08:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    let calls = 0;
    const prices: PriceBook = {
      async quote(asset) {
        calls += 1;
        if (calls === 2) vi.setSystemTime(startedAt.getTime() + 20_000);
        return {
          asset,
          priceUsd: asset === "BTC" ? "80000" : "0.25",
          source: "multi-source-consensus",
          observedAt: new Date(startedAt.getTime() - 895_000).toISOString(),
          ageSeconds: 895,
          confidence: 0.88,
          meaning: "accepted quorum near the freshness boundary",
        };
      },
    };
    const wallet = (asset: "STX" | "BTC", decimals: number): Position => ({
      id: `stacks:wallet:${asset}`,
      type: "wallet",
      protocol: { id: "stacks", version: "api-v1" },
      asset: { asset, amountAtomic: (10n ** BigInt(decimals)).toString(), decimals, valueUsd: null },
      spendable: true,
      provenance: [{ source: "stacks-api", observedAt: startedAt.toISOString() }],
      confidence: { state: "verified", score: 0.92, reasons: [] },
    });

    try {
      const result = await enrichPositionsWithUsd([wallet("STX", 6), wallet("BTC", 8)], prices);
      expect(result.positions.map((position) => position.type === "wallet" ? position.asset.valueUsd : null))
        .toEqual(["0.25", "80000"]);
      expect(result.warnings).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when fewer than two usable market sources remain", async () => {
    const unavailable: PriceBook = { async quote() { return null; } };
    const onlySource: PriceBook = {
      async quote(asset) {
        return {
          asset,
          priceUsd: "0.267",
          source: "dia",
          observedAt: "2026-09-08T10:00:00.000Z",
          ageSeconds: 10,
          confidence: 0.9,
          meaning: "DIA evidence",
        };
      },
    };
    await expect(new QuorumPriceBook([onlySource, unavailable], 2, 150).quote("STX")).resolves.toBeNull();
  });

  it("fails closed when DIA and Pyth exceed the configured divergence", async () => {
    const dia = book({ BTC: "80000" });
    const farPyth: PriceBook = {
      async quote(asset) {
        return {
          asset,
          priceUsd: "76000",
          source: "pyth",
          observedAt: "2026-09-05T00:00:00.000Z",
          ageSeconds: 1,
          confidence: 0.92,
          meaning: "Pyth",
        };
      },
    };
    await expect(new DivergenceAwarePriceBook(dia, farPyth, 150).quote("BTC")).resolves.toBeNull();
    const closePyth: PriceBook = {
      async quote(asset) {
        return {
          asset,
          priceUsd: "79920",
          source: "pyth",
          observedAt: "2026-09-05T00:00:00.000Z",
          ageSeconds: 1,
          confidence: 0.92,
          meaning: "Pyth",
        };
      },
    };
    await expect(new DivergenceAwarePriceBook(dia, closePyth, 150).quote("BTC")).resolves.toMatchObject({
      source: "dia-pyth-consensus",
      priceUsd: "79960",
      confidence: 0.9,
    });
    await expect(new DivergenceAwarePriceBook(dia, closePyth, 150).quote("USDCx")).resolves.toBeNull();
  });

  it("prices USDCx from a registry-approved Bitflow active bin and rejects a depeg", async () => {
    const poolContract = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
    const registry = async () => ({
      version: "2026-09-05.1",
      network: "mainnet" as const,
      issuedAt: "2026-09-05T00:00:00.000Z",
      expiresAt: "2027-09-05T00:00:00.000Z",
      entries: [
        {
          protocol: "sbtc",
          adapterVersion: "mainnet",
          network: "mainnet" as const,
          contractPrincipal: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
          interfaceHash: `sha256:${"b".repeat(64)}`,
          activationBlock: 1,
          supportedAssets: ["sBTC"],
          assetDefinitions: [],
          readOnlyFunctions: [],
          transactionFunctions: [],
          evidenceUrls: ["https://example.com/sbtc-a", "https://example.com/sbtc-b"],
          enabled: true,
        },
        {
          protocol: "bitflow",
          adapterVersion: "mainnet",
          network: "mainnet" as const,
          contractPrincipal: poolContract,
          interfaceHash: `sha256:${"a".repeat(64)}`,
          activationBlock: 1,
          supportedAssets: ["sBTC", "USDCx"],
          assetDefinitions: [],
          readOnlyFunctions: [],
          transactionFunctions: [],
          evidenceUrls: ["https://example.com/a", "https://example.com/b"],
          enabled: true,
        },
      ],
    });
    const request = async (input: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/v1/pools")
            ? {
                pools: [
                  {
                    pool_id: "dlmm_1",
                    pool_token: poolContract,
                    token_x: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
                    token_y: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
                  },
                ],
              }
            : { success: true, price: "80000000000", applied_block_height: 900 },
        ),
        { status: 200 },
      );
    const prices = new BitflowMarketPriceBook(
      book({ BTC: "80000" }),
      registry,
      "https://app.test",
      "https://quotes.test",
      500,
      request,
      () => new Date("2026-09-05T00:00:00.000Z"),
    );
    await expect(prices.quote("USDCx")).resolves.toMatchObject({
      asset: "USDCx",
      priceUsd: "1",
      source: "bitflow-market",
      confidence: 0.88,
      meaning: expect.stringContaining("block 900"),
    });

    const depegRequest = async (input: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/v1/pools")
            ? {
                pools: [
                  {
                    pool_id: "dlmm_1",
                    pool_token: poolContract,
                    token_x: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
                    token_y: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
                  },
                ],
              }
            : { success: true, price: "70000000000", applied_block_height: 900 },
        ),
        { status: 200 },
      );
    await expect(
      new BitflowMarketPriceBook(
        book({ BTC: "80000" }),
        registry,
        "https://app.test",
        "https://quotes.test",
        500,
        depegRequest,
      ).quote("USDCx"),
    ).resolves.toBeNull();
  });

  it("refuses fixture-source quotes during enrichment", async () => {
    const fixtureBook: PriceBook = {
      async quote(asset) {
        return {
          asset,
          priceUsd: "1.00",
          source: "fixture",
          observedAt: "2026-09-04T00:00:00.000Z",
          ageSeconds: null,
          confidence: 0.1,
          meaning: "fixture",
        };
      },
    };
    const position: Position = {
      id: "wallet:stx",
      type: "wallet",
      protocol: { id: "stacks", version: "v1" },
      asset: { asset: "STX", amountAtomic: "1000000", decimals: 6, valueUsd: null },
      spendable: true,
      provenance: [{ source: "stacks-api", observedAt: "2026-09-04T00:00:00.000Z" }],
      confidence: { state: "estimated", score: 0.5, reasons: [] },
    };
    const enriched = await enrichPositionsWithUsd([position], fixtureBook);
    expect(enriched.positions[0]).toMatchObject({ asset: { valueUsd: null } });
    expect(
      enriched.warnings.some((warning) => /Rejected USD quote.*fixture prices are forbidden/.test(warning)),
    ).toBe(true);
  });

  it("rejects a stale observation even when a provider claims age zero", async () => {
    const positions = await (async () => {
      const position: Position = {
        id: "wallet:stale",
        type: "wallet",
        protocol: { id: "stacks", version: "mainnet" },
        asset: { asset: "STX", amountAtomic: "1000000", decimals: 6, valueUsd: null },
        spendable: true,
        provenance: [{ source: "stacks-api", observedAt: new Date().toISOString() }],
        confidence: { state: "verified", score: 0.9, reasons: [] },
      };
      return [position];
    })();
    const result = await enrichPositionsWithUsd(positions, {
      async quote(asset) {
        return {
          asset,
          priceUsd: "1",
          source: "dia",
          observedAt: "2020-01-01T00:00:00.000Z",
          ageSeconds: 0,
          confidence: 0.9,
          meaning: "provider incorrectly reports a fresh age",
        };
      },
    });
    expect(result.positions[0]).toMatchObject({ type: "wallet", asset: { valueUsd: null } });
    expect(result.positions[0]?.confidence.state).toBe("degraded");
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/stale/)]));
  });

  it("marks an unknown wallet token unsupported instead of degrading supported valuations", async () => {
    const position: Position = {
      id: "wallet:unknown",
      type: "wallet",
      protocol: { id: "stacks", version: "mainnet" },
      asset: { asset: "SP123.contract::unknown", amountAtomic: "42", decimals: 0, valueUsd: null },
      spendable: true,
      provenance: [{ source: "stacks-api", observedAt: new Date().toISOString() }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const result = await enrichPositionsWithUsd([position], { async quote() { return null; } });
    expect(result.positions[0]?.confidence.state).toBe("unsupported");
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^Unsupported wallet asset/)]));
  });

  it("keeps zvstBTC classified as supported when its live strategy quote is temporarily unavailable", async () => {
    const position: Position = {
      id: "supply:zvstbtc",
      type: "supply",
      protocol: { id: "zest", version: "v2", contract: "SP.strategy" },
      asset: { asset: "zvstBTC", amountAtomic: "100000000", decimals: 8, valueUsd: null },
      provenance: [{ source: "contract-read", observedAt: new Date().toISOString() }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };

    const result = await enrichPositionsWithUsd([position], { async quote() { return null; } });
    expect(result.positions[0]?.confidence.state).toBe("degraded");
    expect(result.warnings).toContain("No USD quote for supplied asset zvstBTC");
    expect(result.warnings.some((warning) => warning.startsWith("Unsupported wallet asset"))).toBe(false);
  });
});
