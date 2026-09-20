import { z } from "zod";
import { principalCV, uintCV } from "@stacks/transactions";
import type { Position, ProtocolAdapter } from "../../domain/src/index.js";
import { ratioToDecimal } from "../../domain/src/money.js";
import { asList, asTuple, asUint, tupleField, unwrapOk } from "./clarity-values.js";
import { enabledProtocolEntries, type RegistryManifestProvider } from "./registry-provider.js";
import { StacksReadOnlyClient } from "./stacks-read-only-client.js";

const positionSchema = z
  .object({
    poolId: z.string(),
    poolContract: z.string(),
    priceRangeMin: z.number().nonnegative().nullable(),
    priceRangeMax: z.number().nonnegative().nullable(),
    liquidityTokenX: z.number().nonnegative().optional(),
    liquidityTokenY: z.number().nonnegative().optional(),
    tokens: z.object({
      tokenX: z.object({ symbol: z.string() }).passthrough(),
      tokenY: z.object({ symbol: z.string() }).passthrough(),
    }).optional(),
    valueUsd: z.number().nonnegative().nullable(),
    apy: z.number().nonnegative().nullable().optional(),
  })
  .passthrough();
const positionsSchema = z.object({ positions: z.array(positionSchema) }).passthrough();

function isExplicitlyEmptyPosition(position: z.infer<typeof positionSchema>): boolean {
  return (
    position.liquidityTokenX === 0 &&
    position.liquidityTokenY === 0 &&
    position.valueUsd === 0
  );
}
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
const quotePoolsSchema = z.object({
  pools: z.array(z.object({
    pool_id: z.string(),
    pool_token: z.string(),
  }).passthrough()),
}).passthrough();

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

function normalizedRange(lowerInput: number, upperInput: number, current: string) {
  const currentNumber = Number(current);
  const candidates = [
    { lower: lowerInput, upper: upperInput },
    { lower: lowerInput / 1_000_000, upper: upperInput / 1_000_000 },
  ];
  const match = candidates.find(({ lower, upper }) =>
    Number.isFinite(lower) && Number.isFinite(upper) && lower <= currentNumber && currentNumber <= upper);
  if (!match) {
    throw new Error(
      `Bitflow range units cannot be reconciled with active price for ${lowerInput}..${upperInput} at ${current}`,
    );
  }
  return {
    lower: ratioToDecimal(BigInt(Math.round(match.lower * 1_000_000)), 1_000_000n, 6)!,
    upper: ratioToDecimal(BigInt(Math.round(match.upper * 1_000_000)), 1_000_000n, 6)!,
  };
}

export class BitflowMainnetAdapter implements ProtocolAdapter {
  readonly id = "bitflow";
  private quotePoolIds: Map<string, string> | null = null;

  constructor(
    private readonly registry: RegistryManifestProvider,
    private readonly appApiUrl = "https://bff.bitflowapis.finance/api/app",
    private readonly quotesApiUrl = "https://bff.bitflowapis.finance/api/quotes",
    private readonly request: typeof fetch = fetch,
    private readonly stacksApiUrl = "https://api.mainnet.hiro.so",
    private readonly hiroApiKey?: string,
    private readonly consensusClient?: StacksReadOnlyClient,
  ) {}

  async discover(address: string): Promise<Position[]> {
    const entries = enabledProtocolEntries(await this.registry(), "bitflow");
    if (entries.length === 0)
      throw new Error("active signed registry contains no enabled Bitflow pool contracts");
    const allowed = new Map(entries.map((entry) => [entry.contractPrincipal, entry]));
    const response = await this.get(`${this.appApiUrl}/v1/users/${address}/positions`);
    const positions = positionsSchema
      .parse(await response.json())
      .positions
      // Bitflow currently returns zero-valued placeholders for pools in which the
      // address has no liquidity. They are not positions and may omit range data.
      // Only discard a record when all three provider amount signals explicitly
      // agree on zero; missing or conflicting quantities still fail closed below.
      .filter((position) => !isExplicitlyEmptyPosition(position));
    return Promise.all(
      positions.map(async (position): Promise<Position> => {
        const registryEntry = allowed.get(position.poolContract);
        if (!registryEntry)
          throw new Error(`Bitflow returned an unapproved pool contract: ${position.poolContract}`);
        if (position.priceRangeMin === null || position.priceRangeMax === null) {
          throw new Error(`Bitflow returned an active position without range data: ${position.poolId}`);
        }
        const [poolResponse, quotePoolId, nftCount] = await Promise.all([
          this.get(`${this.appApiUrl}/v1/pools/${encodeURIComponent(position.poolId)}`),
          this.quotePoolId(position.poolContract, position.poolId),
          this.countPoolNfts(address, position.poolContract),
        ]);
        const activeResponse = await this.get(
          `${this.quotesApiUrl}/v1/bins/${encodeURIComponent(quotePoolId)}/active`,
        );
        const pool = poolSchema.parse(await poolResponse.json());
        const active = activeBinSchema.parse(await activeResponse.json());
        if (pool.poolContract !== position.poolContract)
          throw new Error("Bitflow pool metadata contract mismatch");
        const current = ratioToDecimal(BigInt(active.price), 1_000_000n, 6)!;
        const { lower, upper } = normalizedRange(position.priceRangeMin, position.priceRangeMax, current);
        const observedAt = new Date().toISOString();
        const nftReconciled = nftCount > 0;
        const nftConflict = nftCount === 0;
        const canonicalAmounts = await this.canonicalAmounts(address, position.poolContract, registryEntry.readOnlyFunctions);
        if (!canonicalAmounts && (position.liquidityTokenX === undefined || position.liquidityTokenY === undefined)) {
          throw new Error(
            `Bitflow omitted token quantities for ${position.poolContract} and canonical bin reconciliation was unavailable`,
          );
        }
        const tokenXAtomic = canonicalAmounts?.tokenX.toString()
          ?? decimalNumberToAtomic(position.liquidityTokenX!, pool.tokens.tokenX.decimals);
        const tokenYAtomic = canonicalAmounts?.tokenY.toString()
          ?? decimalNumberToAtomic(position.liquidityTokenY!, pool.tokens.tokenY.decimals);
        return {
          id: `bitflow:liquidity:${address}:${position.poolId}`,
          type: "liquidity",
          protocol: { id: "bitflow", version: registryEntry.adapterVersion, contract: position.poolContract },
          token0: {
            asset: pool.tokens.tokenX.symbol,
            amountAtomic: tokenXAtomic,
            decimals: pool.tokens.tokenX.decimals,
            valueUsd: null,
          },
          token1: {
            asset: pool.tokens.tokenY.symbol,
            amountAtomic: tokenYAtomic,
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
            provenance: [{ source: "quote", blockHeight: active.applied_block_height, observedAt }],
            confidence: {
              state: "estimated",
              score: 0.6,
              reasons: [
                "APY is reported by the Bitflow API and has not been reconstructed from canonical fee and incentive events",
              ],
            },
          },
          provenance: [
            { source: "quote", blockHeight: active.applied_block_height, observedAt },
            ...(canonicalAmounts
              ? [{ source: "contract-read" as const, observedAt, blockHeight: canonicalAmounts.blockHeight }]
              : []),
            ...(nftReconciled
              ? [{ source: "stacks-api" as const, observedAt, blockHeight: active.applied_block_height }]
              : []),
          ],
          confidence: {
            state: canonicalAmounts && nftReconciled ? "verified" : "estimated",
            score: canonicalAmounts && nftReconciled ? 0.92 : nftReconciled ? 0.78 : 0.65,
            reasons: [
              "Pool contract is registry-approved and active-bin state has block provenance",
              canonicalAmounts
                ? `Token quantities were derived pro rata from canonical user shares and bin balances at Stacks block ${canonicalAmounts.blockHeight}`
                : "Token quantities come from Bitflow's cached API because canonical bin-share reconciliation was unavailable",
              nftReconciled
                ? `Hiro NFT holdings confirm ownership of ${position.poolContract}::pool-token-id`
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

  private async canonicalAmounts(address: string, poolContract: string, allowedFunctions: string[]) {
    if (!this.consensusClient) return null;
    if (!["get-user-bins", "get-bin-balances", "get-balance"].every((name) => allowedFunctions.includes(name))) {
      return null;
    }
    try {
      const pinned = await this.consensusClient.pinTip();
      const bins = asList(
        unwrapOk(await pinned.call(poolContract, "get-user-bins", [principalCV(address)])),
      ).map(asUint);
      // Interactive analysis has a strict read budget. More than 16 historical bins
      // would require at least 32 sequentially throttled RPC calls and can keep a page
      // open for minutes. Large-bin positions use Bitflow's returned quantities with
      // an explicit estimated confidence state; the persistent event projector remains
      // responsible for canonical amount reconciliation.
      if (bins.length > 16) return null;
      let tokenX = 0n;
      let tokenY = 0n;
      // Keep concurrency modest: each bin performs two reads. Larger batches
      // were faster but caused real provider-side reconciliation failures.
      for (let index = 0; index < bins.length; index += 4) {
        const batch = bins.slice(index, index + 4);
        const reconciled = await Promise.all(batch.map(async (binId) => {
          const [sharesCv, balancesCv] = await Promise.all([
            pinned.call(poolContract, "get-balance", [uintCV(binId), principalCV(address)]),
            pinned.call(poolContract, "get-bin-balances", [uintCV(binId)]),
          ]);
          const userShares = asUint(unwrapOk(sharesCv));
          if (userShares === 0n) return { tokenX: 0n, tokenY: 0n };
          const bin = asTuple(unwrapOk(balancesCv));
          const totalShares = asUint(tupleField(bin, "bin-shares"));
          if (totalShares === 0n) throw new Error(`Bitflow bin ${binId} has user shares but zero total shares`);
          return {
            tokenX: (asUint(tupleField(bin, "x-balance")) * userShares) / totalShares,
            tokenY: (asUint(tupleField(bin, "y-balance")) * userShares) / totalShares,
          };
        }));
        for (const amount of reconciled) {
          tokenX += amount.tokenX;
          tokenY += amount.tokenY;
        }
      }
      return { tokenX, tokenY, blockHeight: pinned.blockHeight };
    } catch (error) {
      throw new Error(
        `Canonical Bitflow bin reconciliation failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  private async quotePoolId(poolContract: string, providerPoolId: string): Promise<string> {
    // Older app responses expose the quote-service identifier directly. The
    // current API exposes the pool contract in `poolId`, which must first be
    // resolved through the quote service's registry.
    if (!/^(?:SP|SM)[A-Z0-9]+\./.test(providerPoolId)) return providerPoolId;
    if (!this.quotePoolIds) {
      const response = await this.get(`${this.quotesApiUrl}/v1/pools`);
      this.quotePoolIds = new Map(
        quotePoolsSchema.parse(await response.json()).pools.map((pool) => [pool.pool_token, pool.pool_id]),
      );
    }
    const poolId = this.quotePoolIds.get(poolContract);
    if (!poolId) throw new Error(`Bitflow quotes API has no identifier for registry pool ${poolContract}`);
    return poolId;
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
