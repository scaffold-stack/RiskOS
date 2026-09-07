import { z } from "zod";
import type { Position, ProtocolAdapter } from "../../domain/src/index.js";
import { ratioToDecimal } from "../../domain/src/money.js";
import { enabledProtocolEntries, type RegistryManifestProvider } from "./registry-provider.js";

const positionSchema = z
  .object({
    poolId: z.string(),
    poolContract: z.string(),
    priceRangeMin: z.number().nonnegative().nullable(),
    priceRangeMax: z.number().nonnegative().nullable(),
    liquidityTokenX: z.number().nonnegative(),
    liquidityTokenY: z.number().nonnegative(),
    xToken: z.string(),
    yToken: z.string(),
    valueUsd: z.number().nonnegative().nullable(),
    apy: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();
const positionsSchema = z.object({ positions: z.array(positionSchema) }).passthrough();
const tokenSchema = z
  .object({ contract: z.string(), symbol: z.string(), decimals: z.number().int().nonnegative() })
  .passthrough();
const poolSchema = z
  .object({
    poolId: z.string(),
    poolContract: z.string(),
    tokens: z.object({ tokenX: tokenSchema, tokenY: tokenSchema }),
  })
  .passthrough();
const activeBinSchema = z
  .object({
    success: z.literal(true),
    pool_id: z.string(),
    price: z.string().regex(/^\d+$/),
    applied_block_height: z.number().int().nonnegative(),
  })
  .passthrough();
const nftHoldingsSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            asset_identifier: z.string(),
            value: z
              .object({ repr: z.string().optional(), hex: z.string().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

function numberToPlain(value: number): string {
  const input = String(value).toLowerCase();
  if (!input.includes("e")) return input;
  const [coefficient, exponentText] = input.split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = `${whole}${fraction}`;
  const point = whole!.length + exponent;
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${"0".repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function decimalNumberToAtomic(value: number, decimals: number): string {
  const plain = numberToPlain(value);
  const [whole, fraction = ""] = plain.split(".");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new Error("Bitflow amount has more precision than the registered token supports");
  }
  return BigInt(`${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}`).toString();
}

export class BitflowMainnetAdapter implements ProtocolAdapter {
  readonly id = "bitflow";

  constructor(
    private readonly registry: RegistryManifestProvider,
    private readonly appApiUrl = "https://bff.bitflowapis.finance/api/app",
    private readonly quotesApiUrl = "https://bff.bitflowapis.finance/api/quotes",
    private readonly request: typeof fetch = fetch,
    private readonly stacksApiUrl = "https://api.mainnet.hiro.so",
    private readonly hiroApiKey?: string,
  ) {}

  async discover(address: string): Promise<Position[]> {
    const entries = enabledProtocolEntries(await this.registry(), "bitflow");
    if (entries.length === 0)
      throw new Error("active signed registry contains no enabled Bitflow pool contracts");
    const allowed = new Map(entries.map((entry) => [entry.contractPrincipal, entry]));
    const response = await this.get(`${this.appApiUrl}/v1/users/${address}/positions`);
    const positions = positionsSchema
      .parse(await response.json())
      .positions.filter((position) => position.liquidityTokenX > 0 || position.liquidityTokenY > 0);
    return Promise.all(
      positions.map(async (position): Promise<Position> => {
        const registryEntry = allowed.get(position.poolContract);
        if (!registryEntry)
          throw new Error(`Bitflow returned an unapproved pool contract: ${position.poolContract}`);
        if (position.priceRangeMin === null || position.priceRangeMax === null) {
          throw new Error(`Bitflow returned an active position without range data: ${position.poolId}`);
        }
        const [poolResponse, activeResponse, nftCount] = await Promise.all([
          this.get(`${this.appApiUrl}/v1/pools/${encodeURIComponent(position.poolId)}`),
          this.get(`${this.quotesApiUrl}/v1/bins/${encodeURIComponent(position.poolId)}/active`),
          this.countPoolNfts(address, position.poolContract),
        ]);
        const pool = poolSchema.parse(await poolResponse.json());
        const active = activeBinSchema.parse(await activeResponse.json());
        if (pool.poolContract !== position.poolContract)
          throw new Error("Bitflow pool metadata contract mismatch");
        const lower = ratioToDecimal(BigInt(Math.round(position.priceRangeMin)), 1_000_000n, 6)!;
        const upper = ratioToDecimal(BigInt(Math.round(position.priceRangeMax)), 1_000_000n, 6)!;
        const current = ratioToDecimal(BigInt(active.price), 1_000_000n, 6)!;
        const observedAt = new Date().toISOString();
        const nftReconciled = nftCount > 0;
        const nftConflict = nftCount === 0;
        return {
          id: `bitflow:liquidity:${address}:${position.poolId}`,
          type: "liquidity",
          protocol: { id: "bitflow", version: registryEntry.adapterVersion, contract: position.poolContract },
          token0: {
            asset: pool.tokens.tokenX.symbol,
            amountAtomic: decimalNumberToAtomic(position.liquidityTokenX, pool.tokens.tokenX.decimals),
            decimals: pool.tokens.tokenX.decimals,
            valueUsd: null,
          },
          token1: {
            asset: pool.tokens.tokenY.symbol,
            amountAtomic: decimalNumberToAtomic(position.liquidityTokenY, pool.tokens.tokenY.decimals),
            decimals: pool.tokens.tokenY.decimals,
            valueUsd: null,
          },
          lowerPrice: lower,
          upperPrice: upper,
          currentPrice: current,
          exitSlippageBps: null,
          earnings: {
            annualizedRateBps: position.apy == null ? null : Math.round(position.apy * 100),
            rateKind: "provider-apy",
            earnedToDateUsd: null,
            observedAtBlock: active.applied_block_height,
            meaning:
              "Bitflow-reported position APY can include fees or incentives. Earned-to-date is unavailable without a reconciled entry-value checkpoint.",
          },
          provenance: [
            { source: "quote", blockHeight: active.applied_block_height, observedAt },
            ...(nftReconciled
              ? [{ source: "stacks-api" as const, observedAt, blockHeight: active.applied_block_height }]
              : []),
          ],
          confidence: {
            state: nftReconciled ? "verified" : "estimated",
            score: nftReconciled ? 0.88 : 0.72,
            reasons: [
              "Pool contract is registry-approved and active-bin state has block provenance",
              nftReconciled
                ? `Hiro NFT holdings confirm ${nftCount} ${position.poolContract}::pool-token-id position(s) for this address`
                : nftConflict
                  ? "Bitflow API reports liquidity but Hiro NFT holdings returned no pool-token-id for this address; quantities remain estimated"
                  : "Token quantities come from Bitflow's cached API; NFT reconcile was unavailable",
              "USD valuation is applied by the pricing service after discovery",
            ],
          },
        };
      }),
    );
  }

  private async countPoolNfts(address: string, poolContract: string): Promise<number> {
    const asset = `${poolContract}::pool-token-id`;
    const url = new URL(`${this.stacksApiUrl.replace(/\/$/, "")}/extended/v1/tokens/nft/holdings`);
    url.searchParams.set("principal", address);
    url.searchParams.set("asset_identifiers", asset);
    url.searchParams.set("limit", "50");
    try {
      const response = await this.request(url, {
        headers: {
          accept: "application/json",
          "user-agent": "riskos/0.1",
          ...(this.hiroApiKey ? { "x-api-key": this.hiroApiKey } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return 0;
      const body = nftHoldingsSchema.parse(await response.json());
      return body.results.filter((item) => item.asset_identifier === asset).length;
    } catch {
      return 0;
    }
  }

  private async get(url: string) {
    const response = await this.request(url, {
      headers: { accept: "application/json", "user-agent": "riskos/0.1" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Bitflow API returned ${response.status}`);
    return response;
  }
}
