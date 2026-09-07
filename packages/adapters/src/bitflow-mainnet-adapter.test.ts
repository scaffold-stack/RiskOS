import { describe, expect, it, vi } from "vitest";
import { registryManifestSchema } from "../../data-foundation/src/registry.js";
import { BitflowMainnetAdapter } from "./bitflow-mainnet-adapter.js";

const poolContract = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
const manifest = registryManifestSchema.parse({
  version: "2026-09-04.1",
  network: "mainnet",
  issuedAt: "2026-09-04T00:00:00.000Z",
  expiresAt: "2026-10-04T00:00:00.000Z",
  entries: [
    {
      protocol: "bitflow",
      adapterVersion: "bitflow-dlmm-api-v1-readonly-2026-09",
      network: "mainnet",
      contractPrincipal: poolContract,
      interfaceHash: `sha256:${"a".repeat(64)}`,
      activationBlock: 1,
      supportedAssets: ["sBTC", "USDCx"],
      readOnlyFunctions: [],
      transactionFunctions: [],
      evidenceUrls: ["https://bitflow.example/pool", "https://explorer.example/pool"],
      enabled: true,
    },
  ],
});

describe("BitflowMainnetAdapter", () => {
  it("normalizes an approved pool and attaches active-bin block provenance", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/tokens/nft/holdings")) {
        return new Response(
          JSON.stringify({
            results: [{ asset_identifier: `${poolContract}::pool-token-id`, value: { repr: "u1" } }],
          }),
          { status: 200 },
        );
      }
      const payload = url.endsWith("/positions")
        ? {
            positions: [
              {
                poolId: "dlmm_1",
                poolContract,
                priceRangeMin: 71_418_653_603,
                priceRangeMax: 90_689_326_801,
                liquidityTokenX: 1.79919,
                liquidityTokenY: 143_967.34532,
                xToken: "sbtc",
                yToken: "usdcx",
                valueUsd: 289_978.73,
                apy: 40.89,
              },
            ],
          }
        : url.includes("/bins/")
          ? {
              success: true,
              pool_id: "dlmm_1",
              price: "81165893955",
              applied_block_height: 8915546,
            }
          : {
              poolId: "dlmm_1",
              poolContract,
              tokens: {
                tokenX: { contract: "sbtc", symbol: "sBTC", decimals: 8 },
                tokenY: { contract: "usdcx", symbol: "USDCx", decimals: 6 },
              },
            };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const positions = await new BitflowMainnetAdapter(
      async () => manifest,
      "https://app.test",
      "https://quotes.test",
      request,
      "https://stacks.test",
    ).discover("SP000000000000000000002Q6VF78");
    expect(positions[0]).toMatchObject({
      type: "liquidity",
      token0: { asset: "sBTC", amountAtomic: "179919000", decimals: 8 },
      token1: { asset: "USDCx", amountAtomic: "143967345320", decimals: 6 },
      lowerPrice: "71418.653603",
      upperPrice: "90689.326801",
      currentPrice: "81165.893955",
      earnings: { annualizedRateBps: 4089, rateKind: "provider-apy", earnedToDateUsd: null },
      confidence: { state: "verified" },
    });
    expect(positions[0]?.provenance[0]).toMatchObject({ blockHeight: 8915546, source: "quote" });
    expect(positions[0]?.provenance.some((item) => item.source === "stacks-api")).toBe(true);
  });

  it("rejects a pool that the API returns outside the activated registry", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          positions: [
            {
              poolId: "evil",
              poolContract: "SP000000000000000000002Q6VF78.pool",
              priceRangeMin: 1,
              priceRangeMax: 2,
              liquidityTokenX: 1,
              liquidityTokenY: 1,
              xToken: "x",
              yToken: "y",
              valueUsd: null,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await expect(
      new BitflowMainnetAdapter(
        async () => manifest,
        "https://app.test",
        "https://quotes.test",
        request,
        "https://stacks.test",
      ).discover("SP000000000000000000002Q6VF78"),
    ).rejects.toThrow(/unapproved pool contract/);
  });
});
