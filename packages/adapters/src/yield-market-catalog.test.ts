import { describe, expect, it, vi } from "vitest";
import { Cl, cvToHex, responseOkCV, uintCV } from "@stacks/transactions";
import type { RegistryManifest } from "../../data-foundation/src/index.js";
import type { Position } from "../../domain/src/index.js";
import { MainnetYieldMarketCatalog, applyYieldMarketRatesToPositions } from "./yield-market-catalog.js";
import { StacksReadOnlyClient } from "./stacks-read-only-client.js";

const manifest: RegistryManifest = {
  version: "2026-09-15.1",
  network: "mainnet",
  issuedAt: "2026-09-15T00:00:00.000Z",
  expiresAt: "2026-10-15T00:00:00.000Z",
  entries: [{
    protocol: "hermetica",
    adapterVersion: "v1",
    network: "mainnet",
    contractPrincipal: "SP000000000000000000002Q6VF78.susdh-token-v1",
    interfaceHash: `sha256:${"0".repeat(64)}`,
    activationBlock: 1,
    supportedAssets: ["sUSDh"],
    assetDefinitions: [],
    readOnlyFunctions: [],
    transactionFunctions: [],
    evidenceUrls: ["https://docs.hermetica.fi/a", "https://explorer.hiro.so/b"],
    enabled: true,
  }],
};

describe("yield market catalog", () => {
  it("derives zvstBTC realized APY from two canonical share-price observations", async () => {
    const zestManifest: RegistryManifest = {
      ...manifest,
      entries: [{
        ...manifest.entries[0]!,
        protocol: "zest-v2",
        contractPrincipal: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-assets",
        supportedAssets: ["zvstBTC"],
        assetDefinitions: [{
          assetIdentifier: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zvstBTC::zvstbtc",
          symbol: "zvstBTC",
          decimals: 8,
          spendable: true,
        }],
      }],
    };
    const currentHash = `0x${"b".repeat(64)}`;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/extended/v2/blocks?limit=1")) return new Response(JSON.stringify({
        results: [{ canonical: true, height: 9_000_000, index_block_hash: currentHash }],
      }), { status: 200 });
      if (url.includes("get-share-price")) {
        return new Response(JSON.stringify({ okay: true, result: cvToHex(Cl.ok(Cl.uint(100_100_000))) }), { status: 200 });
      }
      if (url.includes("get-deposit-config")) return new Response(JSON.stringify({
        okay: true,
        result: cvToHex(Cl.tuple({
          "deposit-cap": Cl.uint(2_000_000_000),
          "net-deposited": Cl.uint(1_500_000_000),
          "deposit-enabled": Cl.bool(true),
          "vault-enabled": Cl.bool(true),
          "min-deposit": Cl.uint(100),
        })),
      }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const catalog = new MainnetYieldMarketCatalog(
      async () => zestManifest,
      new StacksReadOnlyClient("https://stacks.test", request),
      "https://bitflow.invalid",
      request,
      () => new Date("2026-09-15T11:39:04.000Z"),
      "https://hermetica.invalid",
      "https://yields.invalid/pools",
    );

    await expect(catalog.discover()).resolves.toContainEqual(expect.objectContaining({
      protocol: "zest",
      assets: "zvstBTC",
      annualizedRateBps: 287,
      rateLabel: "Reward APY",
      evidenceState: "verified",
      observedAtBlock: 9_000_000,
      eligibleForAllocation: false,
      meaning: expect.stringContaining("realized share-price performance"),
    }));
  });

  it("allocates capacity only after exact-contract independent reconciliation", async () => {
    const vault = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-stx";
    const zestManifest: RegistryManifest = {
      ...manifest,
      entries: [{
        ...manifest.entries[0]!,
        protocol: "zest-v2",
        contractPrincipal: vault,
        supportedAssets: ["STX"],
        readOnlyFunctions: ["get-interest-rate", "get-utilization", "get-fee-reserve"],
      }],
    };
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/extended/v2/blocks?limit=1")) return new Response(JSON.stringify({
        results: [{ canonical: true, height: 900, index_block_hash: `0x${"b".repeat(64)}` }],
      }), { status: 200 });
      if (url === "https://yields.test/pools") return new Response(JSON.stringify({ data: [{
        pool: "3020a368-7997-45d2-8f70-0439acb472c2",
        chain: "Stacks",
        project: "zest-v2",
        symbol: "STX",
        tvlUsd: 1_777_349,
        apyBase: 2.7,
        underlyingTokens: ["SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx"],
        count: 190,
        outlier: false,
      }] }), {
        status: 200,
        headers: { date: "Tue, 15 Sep 2026 08:30:00 GMT", age: "60" },
      });
      const functionName = new URL(url).pathname.split("/").at(-1);
      const value = functionName === "get-interest-rate" ? 500 : functionName === "get-utilization" ? 6_000 : 1_000;
      return new Response(JSON.stringify({ okay: true, result: cvToHex(responseOkCV(uintCV(value))) }), { status: 200 });
    });
    const catalog = new MainnetYieldMarketCatalog(
      async () => zestManifest,
      new StacksReadOnlyClient("https://stacks.test", request),
      "https://bitflow.invalid",
      request,
      () => new Date("2026-09-15T08:30:00.000Z"),
      "https://hermetica.invalid",
      "https://yields.test/pools",
    );

    await expect(catalog.discover()).resolves.toContainEqual(expect.objectContaining({
      id: `zest:${vault}`,
      annualizedRateBps: 270,
      tvlUsd: "1777349.00",
      confidenceScore: 0.95,
      eligibleForAllocation: true,
      independentRateEvidence: expect.objectContaining({ differenceBps: 0 }),
      capacityEvidence: expect.objectContaining({ tvlUsd: "1777349.00" }),
    }));
  });

  it("loads Hermetica's official realized APY and TVL without inventing a block", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes("/apy/") ? { apy: "8.00" } : { tvl: "2048137.20" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const registry = vi.fn(async () => manifest);
    const catalog = new MainnetYieldMarketCatalog(
      registry,
      new StacksReadOnlyClient("https://stacks.invalid"),
      "https://bitflow.invalid",
      request,
      () => new Date("2026-09-15T08:00:00.000Z"),
      "https://app.hermetica.fi",
    );

    await expect(catalog.discover()).resolves.toContainEqual(expect.objectContaining({
      id: "hermetica:susdh",
      annualizedRateBps: 800,
      evidenceState: "provider-reported",
      observedAtBlock: null,
      tvlUsd: "2048137.20",
      independentRateEvidence: null,
      capacityEvidence: {
        source: "https://app.hermetica.fi/api/v2c/tvl/usdh",
        observedAt: "2026-09-15T08:00:00.000Z",
        tvlUsd: "2048137.20",
      },
      eligibleForAllocation: false,
    }));
    expect(registry).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Hermetica returns an implausible APY", async () => {
    const request = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      String(input).includes("/apy/") ? { apy: "100.01" } : { tvl: "2048137.20" },
    ), { status: 200 }));
    const catalog = new MainnetYieldMarketCatalog(
      async () => manifest,
      new StacksReadOnlyClient("https://stacks.invalid"),
      "https://bitflow.invalid",
      request,
      () => new Date("2026-09-15T08:00:00.000Z"),
    );

    await expect(catalog.discover()).resolves.toContainEqual(expect.objectContaining({
      id: "hermetica:susdh",
      annualizedRateBps: null,
      evidenceState: "unavailable",
      eligibleForAllocation: false,
    }));
  });

  it("preserves Bitflow's verification flags but never marks its provider APR allocatable", async () => {
    const contract = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
    const bitflowManifest: RegistryManifest = {
      ...manifest,
      entries: [{
        ...manifest.entries[0]!,
        protocol: "bitflow",
        contractPrincipal: contract,
        supportedAssets: ["sBTC", "USDCx"],
        evidenceUrls: ["https://bff.bitflowapis.finance/api/app/v1/pools/dlmm_1"],
      }],
    };
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      poolId: "dlmm_1",
      poolContract: contract,
      poolStatus: true,
      poolVerified: false,
      suggested: false,
      tokens: { tokenX: { symbol: "sBTC" }, tokenY: { symbol: "USDCx" } },
      tvlUsd: 367_528.07,
      apr: 421.71,
    }), { status: 200 }));
    const catalog = new MainnetYieldMarketCatalog(
      async () => bitflowManifest,
      new StacksReadOnlyClient("https://stacks.invalid"),
      "https://bitflow.invalid",
      request,
      () => new Date("2026-09-15T08:00:00.000Z"),
    );

    await expect(catalog.discover()).resolves.toContainEqual(expect.objectContaining({
      protocol: "bitflow",
      annualizedRateBps: 42_171,
      evidenceState: "provider-reported",
      eligibleForAllocation: false,
      meaning: expect.stringContaining("poolVerified=false"),
    }));
  });

  it("maps current receipt-token rates while keeping earned-to-date withheld", () => {
    const position: Position = {
      id: "hermetica:susdh:wallet",
      type: "supply",
      protocol: { id: "hermetica", version: "v1", contract: "SP.contract" },
      asset: { asset: "sUSDh", amountAtomic: "100000000", decimals: 6, valueUsd: "100" },
      provenance: [{ source: "stacks-api", blockHeight: 99, observedAt: "2026-09-15T08:00:00.000Z" }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const [enriched] = applyYieldMarketRatesToPositions([position], [{
      id: "hermetica:susdh",
      protocol: "hermetica",
      kind: "stacking",
      assets: "USDH / sUSDh",
      annualizedRateBps: 800,
      rateLabel: "Reward APY",
      evidenceState: "provider-reported",
      confidenceScore: 0.78,
      observedAtBlock: null,
      observedAt: "2026-09-15T08:00:00.000Z",
      tvlUsd: "2048137.20",
      independentRateEvidence: null,
      capacityEvidence: null,
      source: "https://app.hermetica.fi/api/v2/info/apy/susdh?range=7d",
      meaning: "Official 7-day realized APY.",
      eligibleForAllocation: true,
    }]);

    expect(enriched?.type).toBe("supply");
    if (enriched?.type !== "supply") throw new Error("expected supply position");
    expect(enriched.earnings).toMatchObject({
      annualizedRateBps: 800,
      rateKind: "provider-apy",
      earnedToDateUsd: null,
      observedAtBlock: null,
      confidence: { state: "estimated", score: 0.78 },
    });
  });

  it("maps a Zest receipt token only to its exact underlying vault", () => {
    const position: Position = {
      id: "zest:zststx:wallet",
      type: "supply",
      protocol: { id: "zest", version: "v2", contract: "SP.contract" },
      asset: { asset: "zstSTX", amountAtomic: "1000000", decimals: 6, valueUsd: "1" },
      provenance: [{ source: "stacks-api", blockHeight: 99, observedAt: "2026-09-15T08:00:00.000Z" }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const market = (assets: string, rate: number) => ({
      id: `zest:${assets}`,
      protocol: "zest",
      kind: "lending" as const,
      assets,
      annualizedRateBps: rate,
      rateLabel: "Supply APR" as const,
      evidenceState: "verified" as const,
      confidenceScore: 0.92,
      observedAtBlock: 99,
      observedAt: "2026-09-15T08:00:00.000Z",
      tvlUsd: null,
      independentRateEvidence: null,
      capacityEvidence: null,
      source: `SP.vault-${assets}`,
      meaning: "Pinned vault rate.",
      eligibleForAllocation: rate > 0,
    });
    const [enriched] = applyYieldMarketRatesToPositions([position], [market("STX", 263), market("stSTX", 10)]);

    expect(enriched?.type).toBe("supply");
    if (enriched?.type !== "supply") throw new Error("expected supply position");
    expect(enriched.earnings).toMatchObject({
      annualizedRateBps: 10,
      rateKind: "supply-apr",
      earnedToDateUsd: null,
      observedAtBlock: 99,
      confidence: { state: "verified", score: 0.92 },
    });
  });

  it("attaches the dedicated strategy-vault return only to zvstBTC", () => {
    const position: Position = {
      id: "zest:zvstbtc:wallet",
      type: "supply",
      protocol: { id: "zest", version: "v2", contract: "SP.strategy" },
      asset: { asset: "zvstBTC", amountAtomic: "100000000", decimals: 8, valueUsd: "1" },
      provenance: [{ source: "stacks-api", blockHeight: 99, observedAt: "2026-09-15T08:00:00.000Z" }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const [enriched] = applyYieldMarketRatesToPositions([position], [{
      id: "zest:strategy",
      protocol: "zest",
      kind: "stacking",
      assets: "zvstBTC",
      annualizedRateBps: 0,
      rateLabel: "Reward APY",
      evidenceState: "verified",
      confidenceScore: 0.9,
      observedAtBlock: 100,
      observedAt: "2026-09-15T08:00:00.000Z",
      tvlUsd: null,
      independentRateEvidence: null,
      capacityEvidence: null,
      source: "SP.strategy",
      meaning: "Canonical realized share-price return.",
      eligibleForAllocation: false,
    }]);
    expect(enriched?.type === "supply" ? enriched.earnings : null).toMatchObject({
      annualizedRateBps: 0,
      rateKind: "realized-apy",
      observedAtBlock: 100,
    });
  });

  it("does not attach a rate whose evidence state contradicts its value", () => {
    const position: Position = {
      id: "hermetica:susdh:wallet",
      type: "supply",
      protocol: { id: "hermetica", version: "v1", contract: "SP.contract" },
      asset: { asset: "sUSDh", amountAtomic: "1000000", decimals: 6, valueUsd: "1" },
      provenance: [{ source: "stacks-api", blockHeight: 99, observedAt: "2026-09-15T08:00:00.000Z" }],
      confidence: { state: "verified", score: 0.9, reasons: [] },
    };
    const [unchanged] = applyYieldMarketRatesToPositions([position], [{
      id: "hermetica:susdh",
      protocol: "hermetica",
      kind: "stacking",
      assets: "USDH / sUSDh",
      annualizedRateBps: 800,
      rateLabel: "Reward APY",
      evidenceState: "unavailable",
      confidenceScore: 0,
      observedAtBlock: null,
      observedAt: "2026-09-15T08:00:00.000Z",
      tvlUsd: null,
      independentRateEvidence: null,
      capacityEvidence: null,
      source: "test",
      meaning: "contradictory test input",
      eligibleForAllocation: true,
    }]);
    expect(unchanged?.type === "supply" ? unchanged.earnings : undefined).toBeUndefined();
  });
});
