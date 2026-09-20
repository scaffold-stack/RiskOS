import { z } from "zod";
import { asBool, asTuple, asUint, tupleField, unwrapOk } from "./clarity-values.js";
import type { Position } from "../../domain/src/index.js";
import { enabledProtocolEntries, type RegistryManifestProvider } from "./registry-provider.js";
import { StacksReadOnlyClient } from "./stacks-read-only-client.js";
import { readZestVaultRates } from "./zest-mainnet-adapter.js";
import { mapWithConcurrency } from "./http-retry.js";

export type YieldEvidenceState = "verified" | "provider-reported" | "unavailable";

export interface YieldMarket {
  id: string;
  protocol: string;
  kind: "lending" | "liquidity" | "stacking";
  assets: string;
  annualizedRateBps: number | null;
  rateLabel: "Supply APR" | "Fee APR" | "Reward APY";
  evidenceState: YieldEvidenceState;
  confidenceScore: number;
  observedAtBlock: number | null;
  observedAt: string;
  tvlUsd: string | null;
  independentRateEvidence: {
    source: string;
    observedAt: string;
    annualizedRateBps: number;
    differenceBps: number;
  } | null;
  capacityEvidence: {
    source: string;
    observedAt: string;
    tvlUsd: string;
  } | null;
  source: string;
  meaning: string;
  eligibleForAllocation: boolean;
}

export type YieldMarketProvider = () => Promise<YieldMarket[]>;

const bitflowPoolSchema = z
  .object({
    poolId: z.string(),
    poolContract: z.string(),
    poolStatus: z.boolean(),
    poolVerified: z.boolean(),
    suggested: z.boolean(),
    tokens: z.object({
      tokenX: z.object({ symbol: z.string() }).passthrough(),
      tokenY: z.object({ symbol: z.string() }).passthrough(),
    }),
    tvlUsd: z.number().finite().nonnegative(),
    apr: z.number().finite().nonnegative().max(1_000).nullable(),
  })
  .passthrough();

const numericStringSchema = z.union([z.number().finite(), z.string().regex(/^\d+(?:\.\d+)?$/)]).transform(Number);
const hermeticaApySchema = z
  .object({ apy: numericStringSchema.refine((value) => value >= 0 && value <= 100) })
  .passthrough();
const hermeticaTvlSchema = z
  .object({ tvl: numericStringSchema.refine((value) => value >= 0) })
  .passthrough();

const defiLlamaPoolSchema = z.object({
  pool: z.string().uuid(),
  chain: z.literal("Stacks"),
  project: z.literal("zest-v2"),
  symbol: z.string(),
  tvlUsd: z.number().finite().positive(),
  apyBase: z.number().finite().nonnegative().max(100),
  underlyingTokens: z.array(z.string()).length(1),
  count: z.number().int().nonnegative(),
  outlier: z.boolean(),
}).passthrough();
const defiLlamaResponseSchema = z.object({ data: z.array(z.unknown()) }).passthrough();

interface IndependentZestMarket {
  pool: string;
  underlying: string;
  tvlUsd: string;
  annualizedRateBps: number;
  observedAt: string;
  source: string;
}

const ZEST_UNDERLYING_BY_ASSET: Readonly<Record<string, string>> = {
  STX: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",
  sBTC: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  stSTX: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
  USDCx: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
  USDH: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
  stSTXbtc: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",
};
const MAX_REFERENCE_AGE_SECONDS = 3_600;
const MAX_RATE_DIFFERENCE_BPS = 50;
const ZEST_STRATEGY_TOKEN = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zvstBTC::zvstbtc";
const ZEST_STRATEGY_ENGINE = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zv-engine-stbtc-0";
const ZEST_STRATEGY_STATE = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zv-state-stbtc-0";
const ZEST_STRATEGY_BASELINE_BLOCK = 8_901_901;
const ZEST_STRATEGY_BASELINE_AT = "2026-09-02T14:03:20.000Z";
const ZEST_STRATEGY_BASELINE_PRICE = 100_000_000n;
const ZEST_STRATEGY_BASELINE_TX = "0x12c2de7ebf06da2ff93bc82dbbffb37ea8b6efeb0e61c33a3288b9dae05fa0c1";
const SECONDS_PER_YEAR = 31_536_000;

const EARNING_PROTOCOLS = new Set(["zest-v2", "bitflow", "hermetica", "granite", "stackingdao", "stacking-dao"]);

export class MainnetYieldMarketCatalog {
  constructor(
    private readonly registry: RegistryManifestProvider,
    private readonly stacks: StacksReadOnlyClient,
    private readonly bitflowAppApiUrl = "https://bff.bitflowapis.finance/api/app",
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly hermeticaApiUrl = "https://app.hermetica.fi",
    private readonly defiLlamaYieldsApiUrl = "https://yields.llama.fi/pools",
  ) {}

  async discover(): Promise<YieldMarket[]> {
    const manifest = await this.registry();
    if (!manifest) throw new Error("active signed registry is required for market discovery");
    // Stacks-backed markets run serially so vault + strategy reads do not race the
    // shared tip quota. External HTTP sources can still overlap afterward.
    const zest = await this.zestMarkets(manifest).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );
    const zestStrategy = await this.zestStrategyMarket(manifest).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );
    const [bitflow, hermetica, independentZest] = await Promise.allSettled([
      this.bitflowMarkets(manifest),
      this.hermeticaMarkets(manifest),
      this.independentZestMarkets(),
    ]);
    const zestMarkets = zest.status === "fulfilled"
      ? this.reconcileZestMarkets(zest.value, independentZest.status === "fulfilled" ? independentZest.value : [])
      : [];
    const markets = [
      ...zestMarkets,
      ...(zestStrategy.status === "fulfilled" && zestStrategy.value ? [zestStrategy.value] : []),
      ...(bitflow.status === "fulfilled" ? bitflow.value : []),
      ...(hermetica.status === "fulfilled" ? hermetica.value : []),
    ];
    const represented = new Set(markets.map((market) => market.protocol));
    for (const protocol of new Set(
      manifest.entries
        .filter((entry) => entry.enabled && EARNING_PROTOCOLS.has(entry.protocol))
        .map((entry) => entry.protocol),
    )) {
      const normalized = protocol === "zest-v2" ? "zest" : protocol;
      if (represented.has(normalized)) continue;
      const assets = [
        ...new Set(
          manifest.entries
            .filter((entry) => entry.enabled && entry.protocol === protocol)
            .flatMap((entry) => entry.supportedAssets),
        ),
      ];
      markets.push({
        id: `coverage:${normalized}`,
        protocol: normalized,
        kind: protocol === "stackingdao" || protocol === "stacking-dao" ? "stacking" : "lending",
        assets: assets.join(" / ") || "Registry-approved markets",
        annualizedRateBps: null,
        rateLabel: protocol === "stackingdao" || protocol === "stacking-dao" ? "Reward APY" : "Supply APR",
        evidenceState: "unavailable",
        confidenceScore: 0,
        observedAtBlock: null,
        observedAt: this.now().toISOString(),
        tvlUsd: null,
        independentRateEvidence: null,
        capacityEvidence: null,
        source: "signed-registry",
        meaning: `${normalized} is covered by the signed contract registry, but no current annualized return has passed its protocol-specific evidence checks.`,
        eligibleForAllocation: false,
      });
    }
    return markets.sort((a, b) => (b.annualizedRateBps ?? -1) - (a.annualizedRateBps ?? -1));
  }

  private async zestStrategyMarket(
    manifest: NonNullable<Awaited<ReturnType<RegistryManifestProvider>>>,
  ): Promise<YieldMarket | null> {
    const assetApproved = enabledProtocolEntries(manifest, "zest-v2").some((entry) =>
      entry.assetDefinitions.some((asset) => asset.assetIdentifier === ZEST_STRATEGY_TOKEN),
    );
    if (!assetApproved) return null;

    const observedAt = this.now().toISOString();
    try {
      const current = await this.stacks.pinTip();
      const currentPrice = asUint(unwrapOk(await current.call(ZEST_STRATEGY_ENGINE, "get-share-price", [])));
      const depositConfig = asTuple(await current.call(ZEST_STRATEGY_STATE, "get-deposit-config", []));
      const baselinePrice = ZEST_STRATEGY_BASELINE_PRICE;
      const initializedAtMs = Date.parse(ZEST_STRATEGY_BASELINE_AT);
      const elapsedSeconds = Math.floor((this.now().getTime() - initializedAtMs) / 1_000);
      if (elapsedSeconds < 86_400) throw new Error("fewer than 24 hours of canonical share-price history are available");

      const totalReturn = Number(currentPrice) / Number(baselinePrice) - 1;
      const annualized = Math.pow(1 + totalReturn, SECONDS_PER_YEAR / elapsedSeconds) - 1;
      if (!Number.isFinite(annualized) || annualized <= -1 || annualized > 10)
        throw new Error("annualized share-price return is outside the accepted integrity range");
      const annualizedRateBps = Math.round(annualized * 10_000);
      const depositCap = asUint(tupleField(depositConfig, "deposit-cap"));
      const netDeposited = asUint(tupleField(depositConfig, "net-deposited"));
      const vaultEnabled = asBool(tupleField(depositConfig, "vault-enabled"));
      const depositEnabled = asBool(tupleField(depositConfig, "deposit-enabled"));
      const remainingAtomic = depositCap === 0n ? null : depositCap > netDeposited ? depositCap - netDeposited : 0n;
      const enabled = vaultEnabled && depositEnabled;

      return {
        id: `zest:${ZEST_STRATEGY_ENGINE}`,
        protocol: "zest",
        kind: "stacking",
        assets: "zvstBTC",
        annualizedRateBps,
        rateLabel: "Reward APY",
        evidenceState: "verified",
        confidenceScore: 0.9,
        observedAtBlock: current.blockHeight,
        observedAt,
        tvlUsd: null,
        independentRateEvidence: null,
        capacityEvidence: null,
        source: ZEST_STRATEGY_ENGINE,
        meaning: `Realized annualized return uses the immutable ${ZEST_STRATEGY_BASELINE_TX} deposit event at canonical block ${ZEST_STRATEGY_BASELINE_BLOCK}, where the engine printed a ${baselinePrice} share price, and ${ZEST_STRATEGY_ENGINE}.get-share-price at canonical block ${current.blockHeight}, now ${currentPrice} (8-decimal stBTC units). ${enabled ? "Deposits are enabled" : "Deposits are disabled"}; ${remainingAtomic === null ? "the deposit cap is unlimited on-chain" : `${remainingAtomic} atomic stBTC of the on-chain deposit cap remains`}. This is realized share-price performance, can be negative, and is not Zest's advertised target APY.`,
        // A verified rate alone is not enough to size a recommendation. The
        // strategy remains visible but unallocated until capacity is valued
        // independently in USD.
        eligibleForAllocation: false,
      };
    } catch (error) {
      return {
        id: `zest:${ZEST_STRATEGY_ENGINE}`,
        protocol: "zest",
        kind: "stacking",
        assets: "zvstBTC",
        annualizedRateBps: null,
        rateLabel: "Reward APY",
        evidenceState: "unavailable",
        confidenceScore: 0,
        observedAtBlock: null,
        observedAt,
        tvlUsd: null,
        independentRateEvidence: null,
        capacityEvidence: null,
        source: ZEST_STRATEGY_ENGINE,
        meaning: `Canonical zvstBTC share-price return is unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
        eligibleForAllocation: false,
      };
    }
  }

  private async zestMarkets(manifest: NonNullable<Awaited<ReturnType<RegistryManifestProvider>>>): Promise<YieldMarket[]> {
    const entries = enabledProtocolEntries(manifest, "zest-v2").filter((entry) =>
      /\.v0-vault-(?:stx|sbtc|ststx|usdc|usdh|ststxbtc|stbtc)$/.test(entry.contractPrincipal),
    );
    if (entries.length === 0) return [];
    const pinned = await this.stacks.pinTip();
    const observedAt = this.now().toISOString();
    // One vault at a time. Parallel vault batches were the primary source of
    // QuickNode/Hiro 429s that left individual markets unavailable mid-catalog.
    return mapWithConcurrency(entries, 1, async (entry): Promise<YieldMarket> => {
      try {
        const rates = await readZestVaultRates(pinned, entry);
        const asset = entry.supportedAssets[0] ?? entry.contractPrincipal.split(".").at(-1)!;
        const idleVault = rates.supplyAprBps === 0;
        return {
          id: `zest:${entry.contractPrincipal}`,
          protocol: "zest",
          kind: "lending",
          assets: asset,
          annualizedRateBps: rates.supplyAprBps,
          rateLabel: "Supply APR",
          evidenceState: "verified",
          confidenceScore: 0.92,
          observedAtBlock: pinned.blockHeight,
          observedAt,
          tvlUsd: null,
          independentRateEvidence: null,
          capacityEvidence: null,
          source: entry.contractPrincipal,
          meaning: idleVault
            ? `Verified idle vault at Stacks block ${pinned.blockHeight}: borrow APR ${rates.borrowAprBps} bps and utilization ${rates.utilizationBps} bps, so reconstructed supply APR is 0. This is not a missing rate.`
            : `Supply APR is reconstructed from borrow APR, utilization, and reserve factor read from the allowlisted vault at Stacks block ${pinned.blockHeight}.`,
          eligibleForAllocation: rates.supplyAprBps > 0,
        };
      } catch (error) {
        return {
          id: `zest:${entry.contractPrincipal}`,
          protocol: "zest",
          kind: "lending",
          assets: entry.supportedAssets[0] ?? "Unknown asset",
          annualizedRateBps: null,
          rateLabel: "Supply APR",
          evidenceState: "unavailable",
          confidenceScore: 0,
          observedAtBlock: pinned.blockHeight,
          observedAt,
          tvlUsd: null,
          independentRateEvidence: null,
          capacityEvidence: null,
          source: entry.contractPrincipal,
          meaning: `Pinned vault-rate read failed: ${error instanceof Error ? error.message : "unknown error"}`,
          eligibleForAllocation: false,
        };
      }
    });
  }

  private async independentZestMarkets(): Promise<IndependentZestMarket[]> {
    const response = await this.request(this.defiLlamaYieldsApiUrl, {
      headers: { accept: "application/json", "user-agent": "riskos/0.1-yield-catalog" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`independent yield endpoint returned HTTP ${response.status}`);
    const responseDate = Date.parse(response.headers.get("date") ?? "");
    const ageSeconds = Number(response.headers.get("age") ?? "NaN");
    if (!Number.isFinite(responseDate) || !Number.isFinite(ageSeconds) || ageSeconds < 0)
      throw new Error("independent yield endpoint omitted trustworthy Date/Age headers");
    const observedAtMs = responseDate - ageSeconds * 1_000;
    const referenceAgeSeconds = (this.now().getTime() - observedAtMs) / 1_000;
    if (referenceAgeSeconds < -30 || referenceAgeSeconds > MAX_REFERENCE_AGE_SECONDS)
      throw new Error(`independent yield evidence is stale (${Math.floor(referenceAgeSeconds)}s old)`);
    const payload = defiLlamaResponseSchema.parse(await response.json());
    const source = this.defiLlamaYieldsApiUrl;
    return payload.data.flatMap((candidate) => {
      const parsed = defiLlamaPoolSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.outlier || parsed.data.count < 2) return [];
      return [{
        pool: parsed.data.pool,
        underlying: parsed.data.underlyingTokens[0]!,
        tvlUsd: parsed.data.tvlUsd.toFixed(2),
        annualizedRateBps: Math.round(parsed.data.apyBase * 100),
        observedAt: new Date(observedAtMs).toISOString(),
        source,
      }];
    });
  }

  private reconcileZestMarkets(markets: YieldMarket[], references: IndependentZestMarket[]): YieldMarket[] {
    return markets.map((market) => {
      if (market.annualizedRateBps === null) return market;
      const expectedUnderlying = ZEST_UNDERLYING_BY_ASSET[market.assets];
      const exactMatches = expectedUnderlying
        ? references.filter((candidate) => candidate.underlying.toLowerCase() === expectedUnderlying.toLowerCase())
        : [];
      const reference = exactMatches.length === 1 ? exactMatches[0] : undefined;
      if (!reference) return {
        ...market,
        eligibleForAllocation: false,
        meaning: `${market.meaning} ${exactMatches.length > 1 ? "Independent market records were ambiguous" : "No fresh independent market record matched"} for the exact underlying contract, so capacity and recommendation remain withheld.`,
      };
      const differenceBps = Math.abs(market.annualizedRateBps - reference.annualizedRateBps);
      const independentRateEvidence = {
        source: `${reference.source}#${reference.pool}`,
        observedAt: reference.observedAt,
        annualizedRateBps: reference.annualizedRateBps,
        differenceBps,
      };
      const capacityEvidence = {
        source: `${reference.source}#${reference.pool}`,
        observedAt: reference.observedAt,
        tvlUsd: reference.tvlUsd,
      };
      if (differenceBps > MAX_RATE_DIFFERENCE_BPS) return {
        ...market,
        independentRateEvidence,
        capacityEvidence,
        eligibleForAllocation: false,
        meaning: `${market.meaning} Independent base-yield evidence differs by ${differenceBps} bps, above the ${MAX_RATE_DIFFERENCE_BPS} bps reconciliation limit; no allocation is produced.`,
      };
      return {
        ...market,
        tvlUsd: reference.tvlUsd,
        independentRateEvidence,
        capacityEvidence,
        confidenceScore: 0.95,
        eligibleForAllocation: market.annualizedRateBps > 0,
        meaning: `${market.meaning} The exact underlying contract independently matches DefiLlama pool ${reference.pool}; its base yield differs by ${differenceBps} bps and its reported TVL is $${reference.tvlUsd} (observed ${reference.observedAt}).`,
      };
    });
  }

  private async hermeticaMarkets(manifest: NonNullable<Awaited<ReturnType<RegistryManifestProvider>>>): Promise<YieldMarket[]> {
    const entries = enabledProtocolEntries(manifest, "hermetica");
    if (!entries.some((entry) => entry.supportedAssets.includes("sUSDh"))) return [];
    const observedAt = this.now().toISOString();
    const baseUrl = this.hermeticaApiUrl.replace(/\/$/, "");
    try {
      const headers = { accept: "application/json", "user-agent": "riskos/0.1-yield-catalog" };
      const [apyResponse, tvlResponse] = await Promise.all([
        this.request(`${baseUrl}/api/v2/info/apy/susdh?range=7d`, {
          headers,
          signal: AbortSignal.timeout(8_000),
        }),
        this.request(`${baseUrl}/api/v2c/tvl/usdh`, {
          headers,
          signal: AbortSignal.timeout(8_000),
        }),
      ]);
      if (!apyResponse.ok) throw new Error(`APY endpoint returned HTTP ${apyResponse.status}`);
      if (!tvlResponse.ok) throw new Error(`TVL endpoint returned HTTP ${tvlResponse.status}`);
      const [{ apy }, { tvl }] = await Promise.all([
        hermeticaApySchema.parseAsync(await apyResponse.json()),
        hermeticaTvlSchema.parseAsync(await tvlResponse.json()),
      ]);
      const rate = Math.round(apy * 100);
      const tvlUsd = tvl.toFixed(2);
      const apySource = `${baseUrl}/api/v2/info/apy/susdh?range=7d`;
      const tvlSource = `${baseUrl}/api/v2c/tvl/usdh`;
      return [{
        id: "hermetica:susdh",
        protocol: "hermetica",
        kind: "stacking",
        assets: "USDH / sUSDh",
        annualizedRateBps: rate,
        rateLabel: "Reward APY",
        evidenceState: "provider-reported",
        confidenceScore: 0.78,
        observedAtBlock: null,
        observedAt,
        tvlUsd,
        independentRateEvidence: null,
        capacityEvidence: {
          source: tvlSource,
          observedAt,
          tvlUsd,
        },
        source: apySource,
        meaning: `Hermetica's official SDK endpoint reports ${apy.toFixed(2)}% realized APY over its 7-day window. It is variable provider evidence, not a guaranteed return; reported protocol TVL was $${tvlUsd} at the same observation time.`,
        eligibleForAllocation: false,
      }];
    } catch (error) {
      return [{
        id: "hermetica:susdh",
        protocol: "hermetica",
        kind: "stacking",
        assets: "USDH / sUSDh",
        annualizedRateBps: null,
        rateLabel: "Reward APY",
        evidenceState: "unavailable",
        confidenceScore: 0,
        observedAtBlock: null,
        observedAt,
        tvlUsd: null,
        independentRateEvidence: null,
        capacityEvidence: null,
        source: `${baseUrl}/api/v2/info/apy/susdh?range=7d`,
        meaning: `Current Hermetica rate evidence is unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
        eligibleForAllocation: false,
      }];
    }
  }

  private async bitflowMarkets(manifest: NonNullable<Awaited<ReturnType<RegistryManifestProvider>>>): Promise<YieldMarket[]> {
    const entries = enabledProtocolEntries(manifest, "bitflow");
    const observedAt = this.now().toISOString();
    const markets: YieldMarket[] = [];
    for (let offset = 0; offset < entries.length; offset += 3) {
      const batch = entries.slice(offset, offset + 3);
      const results = await Promise.all(
        batch.map(async (entry): Promise<YieldMarket> => {
          const poolId = entry.evidenceUrls
            .map((url) => url.match(/\/v1\/pools\/([^/?#]+)/)?.[1])
            .find(Boolean);
          if (!poolId)
            return unavailableBitflow(
              entry.contractPrincipal,
              entry.supportedAssets,
              observedAt,
              "Signed registry has no Bitflow application pool identifier.",
            );
          try {
            const response = await this.request(
              `${this.bitflowAppApiUrl.replace(/\/$/, "")}/v1/pools/${encodeURIComponent(poolId)}`,
              {
                headers: { accept: "application/json", "user-agent": "riskos/0.1-yield-catalog" },
                signal: AbortSignal.timeout(8_000),
              },
            );
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const pool = bitflowPoolSchema.parse(await response.json());
            if (pool.poolContract !== entry.contractPrincipal)
              throw new Error("pool contract does not match the signed registry");
            const rate = pool.apr == null ? null : Math.round(pool.apr * 100);
            const tvlUsd = pool.tvlUsd.toFixed(2);
            const poolSource = `${this.bitflowAppApiUrl}/v1/pools/${poolId}`;
            return {
              id: `bitflow:${entry.contractPrincipal}`,
              protocol: "bitflow",
              kind: "liquidity",
              assets: `${pool.tokens.tokenX.symbol} / ${pool.tokens.tokenY.symbol}`,
              annualizedRateBps: rate,
              rateLabel: "Fee APR",
              evidenceState: "provider-reported",
              confidenceScore: 0.7,
              observedAtBlock: null,
              observedAt,
              tvlUsd,
              independentRateEvidence: null,
              capacityEvidence: {
                source: `${poolSource}#tvl`,
                observedAt,
                tvlUsd,
              },
              source: poolSource,
              meaning:
                `Current fee APR and TVL are reported by Bitflow for a pool whose contract matches the signed registry. Bitflow flags: poolStatus=${pool.poolStatus}, poolVerified=${pool.poolVerified}, suggested=${pool.suggested}. The rate is not independently reconstructed from canonical fee events; explore simulations may use it with a provider-reported label.`,
              eligibleForAllocation: false,
            };
          } catch (error) {
            return unavailableBitflow(
              entry.contractPrincipal,
              entry.supportedAssets,
              observedAt,
              error instanceof Error ? error.message : "unknown error",
            );
          }
        }),
      );
      markets.push(...results);
    }
    return markets;
  }
}

const ZEST_RECEIPT_UNDERLYING: Readonly<Record<string, string>> = {
  zstx: "stx",
  zsbtc: "sbtc",
  zststx: "ststx",
  zusdc: "usdcx",
  zusdcx: "usdcx",
  zusdh: "usdh",
  zststxbtc: "ststxbtc",
  zstbtc: "stbtc",
  zvstbtc: "zvstbtc",
};

/**
 * Adds current market-rate evidence to wallet-discovered receipt tokens. It
 * never manufactures earned-to-date yield: that requires canonical cash-flow
 * history, which is deliberately kept null here.
 */
export function applyYieldMarketRatesToPositions(
  positions: Position[],
  markets: readonly YieldMarket[],
): Position[] {
  return positions.map((position): Position => {
    if (position.type !== "supply" || position.earnings) return position;
    const protocol = position.protocol.id.toLowerCase();
    const symbol = position.asset.asset.toLowerCase();
    const underlying = protocol === "zest" ? ZEST_RECEIPT_UNDERLYING[symbol] : undefined;
    const market = markets.find((candidate) => {
      if (candidate.protocol.toLowerCase() !== protocol || candidate.annualizedRateBps === null) return false;
      const acceptedEvidence =
        (candidate.evidenceState === "verified" &&
          candidate.observedAtBlock !== null &&
          candidate.confidenceScore >= 0.8) ||
        (candidate.evidenceState === "provider-reported" && candidate.confidenceScore >= 0.75);
      if (!acceptedEvidence) return false;
      if (protocol === "hermetica") return symbol === "susdh" && candidate.id === "hermetica:susdh";
      const marketAssets = candidate.assets
        .split("/")
        .map((asset) => asset.trim().toLowerCase());
      if (marketAssets.includes(symbol)) return true;
      if (!underlying) return false;
      return marketAssets.includes(underlying);
    });
    if (!market) return position;
    const verified = market.evidenceState === "verified" && market.observedAtBlock !== null;
    const provenance = verified
      ? [{ source: "contract-read" as const, blockHeight: market.observedAtBlock!, observedAt: market.observedAt }]
      : [{ source: "quote" as const, observedAt: market.observedAt }];
    return {
      ...position,
      earnings: {
        annualizedRateBps: market.annualizedRateBps,
        rateKind: verified
          ? market.rateLabel === "Reward APY" ? "realized-apy" : "supply-apr"
          : "provider-apy",
        earnedToDateUsd: null,
        observedAtBlock: market.observedAtBlock,
        meaning: `${market.meaning} The 30-day projection holds this current rate constant. Earned-to-date remains withheld until deposits, withdrawals, share-rate changes, fees, and rewards are reconciled from canonical history.`,
        provenance,
        confidence: verified
          ? { state: "verified", score: market.confidenceScore, reasons: ["Rate reconstructed from pinned allowlisted contract reads"] }
          : { state: "estimated", score: market.confidenceScore, reasons: ["Current rate comes from the protocol's official API and is not reconstructed from canonical reward events"] },
      },
    };
  });
}

function unavailableBitflow(
  contract: string,
  assets: string[],
  observedAt: string,
  reason: string,
): YieldMarket {
  return {
    id: `bitflow:${contract}`,
    protocol: "bitflow",
    kind: "liquidity",
    assets: assets.join(" / ") || "Unknown pair",
    annualizedRateBps: null,
    rateLabel: "Fee APR",
    evidenceState: "unavailable",
    confidenceScore: 0,
    observedAtBlock: null,
    observedAt,
    tvlUsd: null,
    independentRateEvidence: null,
    capacityEvidence: null,
    source: contract,
    meaning: `Current Bitflow market evidence is unavailable: ${reason}`,
    eligibleForAllocation: false,
  };
}
