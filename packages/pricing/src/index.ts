import { stringAsciiCV, uintCV } from "@stacks/transactions";
import { z } from "zod";
import { asPrincipal, asTuple, asUint, tupleField, unwrapOk } from "../../adapters/src/clarity-values.js";
import { StacksReadOnlyClient } from "../../adapters/src/stacks-read-only-client.js";
import type { RegistryManifestProvider } from "../../adapters/src/registry-provider.js";
import { decimalToScaled, ratioToDecimal } from "../../domain/src/money.js";
import type { Position } from "../../domain/src/index.js";

export interface PriceQuote {
  asset: string;
  priceUsd: string;
  source: "dia" | "pyth" | "dia-pyth-consensus" | "stablecoin-peg" | "bitflow-market" | "bitflow-api" | "zest-vault" | "fixture";
  observedAt: string;
  ageSeconds: number | null;
  confidence: number;
  meaning: string;
}

export interface PriceBook {
  quote(asset: string): Promise<PriceQuote | null>;
}

const DIA_ORACLE = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle";
/** Map protocol / receipt tokens to an oracle key until exchange-rate reads are wired. */
const UNDERLYING_FOR_PRICE: Record<string, string> = {
  BTC: "BTC",
  sBTC: "BTC",
  zsBTC: "BTC",
  stBTC: "BTC",
  zstBTC: "BTC",
  stSTXbtc: "BTC",
  zstSTXbtc: "BTC",
  STX: "STX",
  zSTX: "STX",
  stSTX: "STX",
  zstSTX: "STX",
};
const DIA_KEYS: Record<string, string> = {
  BTC: "BTC/USD",
  STX: "STX/USD",
};
const STABLE_ASSETS = new Set(["USDCx", "USDH", "USDC", "USDT", "zUSDCx", "zUSDH"]);
const PRICE_SCALE = 8;
const PYTH_FEEDS: Record<string, string> = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  STX: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
};
const ZEST_RECEIPT_VAULTS: Record<string, { vault: string; underlying: string }> = {
  zSTX: { vault: "v0-vault-stx", underlying: "STX" },
  zsBTC: { vault: "v0-vault-sbtc", underlying: "sBTC" },
  zstSTX: { vault: "v0-vault-ststx", underlying: "stSTX" },
  zUSDCx: { vault: "v0-vault-usdc", underlying: "USDCx" },
  zUSDH: { vault: "v0-vault-usdh", underlying: "USDH" },
  zstSTXbtc: { vault: "v0-vault-ststxbtc", underlying: "stSTXbtc" },
  zstBTC: { vault: "v0-vault-stbtc", underlying: "stBTC" },
};

export function resolvePriceUnderlying(asset: string): string {
  return UNDERLYING_FOR_PRICE[asset] ?? asset;
}

function formatUsdFromScaled(value: bigint, scale = PRICE_SCALE): string {
  return ratioToDecimal(value, 10n ** BigInt(scale), 2) ?? "0";
}

export function atomicAmountToUsd(amountAtomic: string, decimals: number, priceUsd: string): string {
  const amount = BigInt(amountAtomic);
  const price = decimalToScaled(priceUsd, PRICE_SCALE);
  const value = amount * price / 10n ** BigInt(decimals);
  return formatUsdFromScaled(value, PRICE_SCALE);
}

export class DiaOraclePriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();
  private readonly loads = new Map<string, Promise<PriceQuote>>();

  constructor(
    private readonly client: StacksReadOnlyClient,
    private readonly oraclePrincipal = DIA_ORACLE,
    private readonly maxAgeSeconds = 900,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    if (STABLE_ASSETS.has(asset)) {
      return {
        asset,
        priceUsd: "1.00",
        source: "stablecoin-peg",
        observedAt: this.now().toISOString(),
        ageSeconds: 0,
        confidence: 0.7,
        meaning: `${asset} is valued at a $1.00 peg until a dedicated market/oracle quote is wired. Depeg risk is tracked separately.`,
      };
    }
    const underlying = resolvePriceUnderlying(asset);
    const key = DIA_KEYS[underlying];
    if (!key) return null;
    const cached = this.cache.get(key);
    const aliased = asset !== underlying;
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cached.quote,
        asset,
        confidence: Math.min(cached.quote.confidence, aliased ? 0.75 : cached.quote.confidence),
        meaning: aliased
          ? `${asset} priced 1:1 to ${underlying} via ${cached.quote.meaning}`
          : cached.quote.meaning,
      };
    }

    let load = this.loads.get(key);
    if (!load) {
      load = (async () => {
        const pinned = await this.client.pinTip();
        const raw = unwrapOk(await pinned.call(this.oraclePrincipal, "get-value", [stringAsciiCV(key)]));
        const tuple = asTuple(raw);
        const value = asUint(tupleField(tuple, "value"));
        const timestampRaw = Number(asUint(tupleField(tuple, "timestamp")));
        // DIA on Stacks returns millisecond timestamps.
        const timestampMs = timestampRaw > 1_000_000_000_000 ? timestampRaw : timestampRaw * 1000;
        const observedAt = new Date(timestampMs).toISOString();
        const ageSeconds = Math.max(0, Math.floor((this.now().getTime() - timestampMs) / 1000));
        const priceUsd = formatUsdFromScaled(value, PRICE_SCALE);
        const baseMeaning = ageSeconds <= this.maxAgeSeconds
          ? `DIA ${key} = $${priceUsd} (age ${ageSeconds}s at Stacks tip ${pinned.blockHeight}).`
          : `DIA ${key} is stale (${ageSeconds}s old). Valuations are degraded and protective actions stay advisory.`;
        const quote: PriceQuote = {
          asset: underlying,
          priceUsd,
          source: "dia",
          observedAt,
          ageSeconds,
          confidence: ageSeconds <= this.maxAgeSeconds ? 0.9 : 0.45,
          meaning: baseMeaning,
        };
        this.cache.set(key, { quote, expiresAt: Date.now() + 30_000 });
        return quote;
      })();
      this.loads.set(key, load);
    }
    let quote: PriceQuote;
    try {
      quote = await load;
    } finally {
      if (this.loads.get(key) === load) this.loads.delete(key);
    }
    return {
      ...quote,
      asset,
      confidence: Math.min(quote.confidence, aliased ? 0.75 : quote.confidence),
      meaning: aliased ? `${asset} priced 1:1 to ${underlying} via ${quote.meaning}` : quote.meaning,
    };
  }
}

function signedExponentDecimal(value: string, exponent: number): string {
  const integer = BigInt(value);
  if (exponent >= 0) return (integer * 10n ** BigInt(exponent)).toString();
  return ratioToDecimal(integer, 10n ** BigInt(-exponent), Math.min(12, -exponent)) ?? "0";
}

export class PythHermesPriceBook implements PriceBook {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://hermes.pyth.network",
    private readonly maxAgeSeconds = 60,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!token.trim()) throw new Error("A Pyth Hermes/Lazer token is required");
  }

  async quote(asset: string): Promise<PriceQuote | null> {
    const underlying = resolvePriceUnderlying(asset);
    const feed = PYTH_FEEDS[underlying];
    if (!feed) return null;
    const url = new URL("/v2/updates/price/latest", this.baseUrl);
    url.searchParams.append("ids[]", feed);
    const response = await this.request(url, {
      headers: { accept: "application/json", authorization: `Bearer ${this.token}`, "user-agent": "riskos/0.1" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Pyth Hermes latest-price request returned ${response.status}`);
    const body = await response.json() as { parsed?: Array<{ id?: string; price?: { price?: string; expo?: number; publish_time?: number } }> };
    const price = body.parsed?.find((item) => item.id?.replace(/^0x/, "") === feed)?.price;
    if (!price || typeof price.price !== "string" || !Number.isInteger(price.expo) || !Number.isSafeInteger(price.publish_time)) {
      throw new Error(`Pyth ${underlying}/USD response is incomplete`);
    }
    const publishTime = price.publish_time!;
    const observedAt = new Date(publishTime * 1_000).toISOString();
    const ageSeconds = Math.max(0, Math.floor((this.now().getTime() - publishTime * 1_000) / 1_000));
    return {
      asset,
      priceUsd: signedExponentDecimal(price.price, price.expo!),
      source: "pyth",
      observedAt,
      ageSeconds,
      confidence: ageSeconds <= this.maxAgeSeconds ? 0.92 : 0.4,
      meaning: `Pyth ${underlying}/USD feed ${feed.slice(0, 10)}... is ${ageSeconds}s old${ageSeconds > this.maxAgeSeconds ? " and stale" : ""}.`,
    };
  }
}

/** Returns no quote when either configured source fails or they disagree. */
export class DivergenceAwarePriceBook implements PriceBook {
  constructor(
    private readonly primary: PriceBook,
    private readonly reference: PriceBook,
    private readonly maximumDivergenceBps = 150,
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const primary = await this.primary.quote(asset);
    if (!primary || primary.source === "fixture") return null;
    // Pyth consensus currently covers the canonical BTC/USD and STX/USD feeds.
    // Peg assets retain their explicit peg-risk model instead of pretending a
    // non-existent Pyth comparison was performed.
    if (primary.source === "stablecoin-peg") return primary;
    const reference = await this.reference.quote(asset);
    if (!reference || reference.source === "fixture") return null;
    const primaryScaled = decimalToScaled(primary.priceUsd, PRICE_SCALE);
    const referenceScaled = decimalToScaled(reference.priceUsd, PRICE_SCALE);
    if (primaryScaled <= 0n || referenceScaled <= 0n) return null;
    const delta = primaryScaled > referenceScaled ? primaryScaled - referenceScaled : referenceScaled - primaryScaled;
    const divergenceBps = Number(delta * 10_000n / primaryScaled);
    if (divergenceBps > this.maximumDivergenceBps) return null;
    return {
      asset,
      priceUsd: formatUsdFromScaled((primaryScaled + referenceScaled) / 2n, PRICE_SCALE),
      source: "dia-pyth-consensus",
      observedAt: new Date(Math.min(Date.parse(primary.observedAt), Date.parse(reference.observedAt))).toISOString(),
      ageSeconds: Math.max(primary.ageSeconds ?? 0, reference.ageSeconds ?? 0),
      confidence: Math.min(primary.confidence, reference.confidence),
      meaning: `DIA/Pyth midpoint; sources differ by ${divergenceBps} bps (maximum ${this.maximumDivergenceBps}). DIA: ${primary.meaning} Pyth: ${reference.meaning}`,
    };
  }
}

const bitflowPoolsSchema = z.object({
  data: z.array(z.object({
    poolId: z.string(),
    poolContract: z.string(),
    tokens: z.object({
      tokenX: z.object({ symbol: z.string() }).passthrough(),
      tokenY: z.object({ symbol: z.string() }).passthrough(),
    }),
  }).passthrough()),
}).passthrough();
const bitflowActiveBinSchema = z.object({
  success: z.literal(true),
  price: z.string().regex(/^\d+$/),
  applied_block_height: z.number().int().nonnegative(),
}).passthrough();

/** Prices USDCx from the registry-approved Bitflow sBTC/USDCx market and a live BTC/USD oracle. */
export class BitflowMarketPriceBook implements PriceBook {
  private cache: { expiresAt: number; quote: PriceQuote } | null = null;

  constructor(
    private readonly fallback: PriceBook,
    private readonly registry: RegistryManifestProvider,
    private readonly appApiUrl = "https://bff.bitflowapis.finance/api/app",
    private readonly quotesApiUrl = "https://bff.bitflowapis.finance/api/quotes",
    private readonly maximumPegDivergenceBps = 500,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    if (asset !== "USDCx") return this.fallback.quote(asset);
    if (this.cache && this.cache.expiresAt > this.now().getTime()) return this.cache.quote;
    const manifest = await this.registry();
    const allowedPools = new Set(manifest?.entries
      .filter((entry) => entry.enabled && entry.protocol === "bitflow")
      .map((entry) => entry.contractPrincipal) ?? []);
    if (allowedPools.size === 0) return null;
    const poolsResponse = await this.request(`${this.appApiUrl.replace(/\/$/, "")}/v1/pools?limit=100`, {
      headers: { accept: "application/json", "user-agent": "riskos/0.1" }, signal: AbortSignal.timeout(8_000),
    });
    if (!poolsResponse.ok) throw new Error(`Bitflow pool discovery returned ${poolsResponse.status}`);
    const pool = bitflowPoolsSchema.parse(await poolsResponse.json()).data.find((item) => {
      const pair = new Set([item.tokens.tokenX.symbol, item.tokens.tokenY.symbol]);
      return allowedPools.has(item.poolContract) && pair.has("sBTC") && pair.has("USDCx");
    });
    if (!pool) return null;
    const activeResponse = await this.request(`${this.quotesApiUrl.replace(/\/$/, "")}/v1/bins/${encodeURIComponent(pool.poolId)}/active`, {
      headers: { accept: "application/json", "user-agent": "riskos/0.1" }, signal: AbortSignal.timeout(8_000),
    });
    if (!activeResponse.ok) throw new Error(`Bitflow active-bin quote returned ${activeResponse.status}`);
    const active = bitflowActiveBinSchema.parse(await activeResponse.json());
    const rawPrice = BigInt(active.price);
    if (rawPrice <= 0n) return null;
    const btc = await this.fallback.quote("sBTC");
    if (!btc || btc.source === "fixture" || btc.source === "stablecoin-peg") return null;
    const btcUsd = decimalToScaled(btc.priceUsd, PRICE_SCALE);
    const poolPrice = rawPrice * 10n ** BigInt(PRICE_SCALE) / 1_000_000n;
    const usdcUsd = pool.tokens.tokenX.symbol === "sBTC"
      ? btcUsd * 10n ** BigInt(PRICE_SCALE) / poolPrice
      : btcUsd * poolPrice / 10n ** BigInt(PRICE_SCALE);
    const oneDollar = 10n ** BigInt(PRICE_SCALE);
    const divergence = usdcUsd > oneDollar ? usdcUsd - oneDollar : oneDollar - usdcUsd;
    const divergenceBps = Number(divergence * 10_000n / oneDollar);
    if (divergenceBps > this.maximumPegDivergenceBps) return null;
    const quote: PriceQuote = {
      asset,
      priceUsd: ratioToDecimal(usdcUsd, oneDollar, 6) ?? "0",
      source: "bitflow-market",
      observedAt: this.now().toISOString(),
      ageSeconds: 0,
      confidence: Math.min(0.88, btc.confidence),
      meaning: `Registry-approved Bitflow ${pool.poolId} active bin at block ${active.applied_block_height}, anchored to ${btc.source} BTC/USD; ${divergenceBps} bps from $1.`,
    };
    this.cache = { expiresAt: this.now().getTime() + 30_000, quote };
    return quote;
  }
}

/**
 * Values Zest vault receipts with the deployed vault's conversion function at
 * one pinned Stacks tip. The underlying price still retains its own source and
 * confidence semantics (DIA, market quote, or stablecoin peg).
 */
export class ZestVaultExchangeRatePriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();

  constructor(
    private readonly underlyingPrices: PriceBook,
    private readonly client: StacksReadOnlyClient,
    private readonly registry: RegistryManifestProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const conversion = ZEST_RECEIPT_VAULTS[asset];
    if (!conversion) return this.underlyingPrices.quote(asset);
    const cached = this.cache.get(asset);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.quote;

    const manifest = await this.registry();
    const vault = manifest?.entries.find((entry) => entry.enabled && entry.network === "mainnet"
      && entry.protocol === "zest-v2" && entry.contractPrincipal.endsWith(`.${conversion.vault}`));
    if (!vault) return null;
    const underlying = await this.underlyingPrices.quote(conversion.underlying);
    if (!underlying || underlying.source === "fixture") return null;

    const pinned = await this.client.pinTip();
    const [underlyingPrincipalCv, shareDecimalsCv] = await Promise.all([
      pinned.call(vault.contractPrincipal, "get-underlying", []),
      pinned.call(vault.contractPrincipal, "get-decimals", []),
    ]);
    const underlyingPrincipal = asPrincipal(unwrapOk(underlyingPrincipalCv));
    const shareDecimals = asUint(unwrapOk(shareDecimalsCv));
    const underlyingDecimals = asUint(unwrapOk(await pinned.call(underlyingPrincipal, "get-decimals", [])));
    const oneShare = 10n ** shareDecimals;
    const underlyingAtomic = asUint(unwrapOk(await pinned.call(vault.contractPrincipal, "convert-to-assets", [uintCV(oneShare)])));
    const basePrice = decimalToScaled(underlying.priceUsd, PRICE_SCALE);
    const receiptPrice = basePrice * underlyingAtomic / 10n ** underlyingDecimals;
    const priceUsd = formatUsdFromScaled(receiptPrice, PRICE_SCALE);
    const quote: PriceQuote = {
      asset,
      priceUsd,
      source: "zest-vault",
      observedAt: this.now().toISOString(),
      ageSeconds: underlying.ageSeconds,
      confidence: Math.min(0.9, underlying.confidence),
      meaning: `${asset} = ${ratioToDecimal(underlyingAtomic, 10n ** underlyingDecimals, 8)} ${conversion.underlying} via ${vault.contractPrincipal}.convert-to-assets at Stacks block ${pinned.blockHeight}; underlying price: ${underlying.meaning}`,
    };
    this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
    return quote;
  }
}

export class StaticFallbackPriceBook implements PriceBook {
  constructor(private readonly prices: Record<string, string>, private readonly now: () => Date = () => new Date()) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    if (STABLE_ASSETS.has(asset)) {
      return {
        asset, priceUsd: "1.00", source: "stablecoin-peg", observedAt: this.now().toISOString(),
        ageSeconds: 0, confidence: 0.7, meaning: `${asset} pegged at $1.00 for fallback valuation.`,
      };
    }
    const underlying = resolvePriceUnderlying(asset);
    const priceUsd = this.prices[underlying] ?? this.prices[asset];
    if (!priceUsd) return null;
    const aliased = asset !== underlying;
    return {
      asset, priceUsd, source: "fixture", observedAt: this.now().toISOString(), ageSeconds: null,
      confidence: aliased ? 0.35 : 0.4,
      meaning: aliased
        ? `Fallback $${priceUsd} for ${asset} via 1:1 ${underlying}. Prefer DIA + exchange-rate when available.`
        : `Fallback reference price $${priceUsd} for ${asset}. Prefer DIA when available.`,
    };
  }
}

export class CompositePriceBook implements PriceBook {
  constructor(private readonly primary: PriceBook, private readonly fallback?: PriceBook) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    try {
      const primary = await this.primary.quote(asset);
      if (primary) return primary;
    } catch {
      // fall through
    }
    return this.fallback ? this.fallback.quote(asset) : null;
  }
}

function withValue(position: Position, assetField: "asset" | "collateral" | "debt" | "token0" | "token1", valueUsd: string | null, reason: string): Position {
  if ((position.type === "wallet" || position.type === "supply") && assetField === "asset") {
    return {
      ...position,
      asset: { ...position.asset, valueUsd },
      confidence: {
        ...position.confidence,
        score: Math.min(position.confidence.score, valueUsd ? 0.9 : position.confidence.score),
        reasons: [...position.confidence.reasons, reason],
      },
    };
  }
  if (position.type === "lending" && (assetField === "collateral" || assetField === "debt")) {
    return {
      ...position,
      [assetField]: { ...position[assetField], valueUsd },
      confidence: {
        ...position.confidence,
        reasons: position.confidence.reasons.includes(reason) ? position.confidence.reasons : [...position.confidence.reasons, reason],
      },
    } as Position;
  }
  if (position.type === "liquidity" && (assetField === "token0" || assetField === "token1")) {
    return {
      ...position,
      [assetField]: { ...position[assetField], valueUsd },
      confidence: {
        ...position.confidence,
        reasons: position.confidence.reasons.includes(reason) ? position.confidence.reasons : [...position.confidence.reasons, reason],
      },
    } as Position;
  }
  return position;
}

export async function enrichPositionsWithUsd(
  positions: Position[],
  book: PriceBook,
): Promise<{ positions: Position[]; warnings: string[]; quotes: PriceQuote[] }> {
  const warnings: string[] = [];
  const quotes: PriceQuote[] = [];
  const quoteCache = new Map<string, PriceQuote | null>();
  async function cachedQuote(asset: string) {
    if (!quoteCache.has(asset)) {
      try {
        quoteCache.set(asset, await book.quote(asset));
      } catch (error) {
        warnings.push(`Price book degraded for ${asset}: ${error instanceof Error ? error.message : "unknown error"}`);
        quoteCache.set(asset, null);
      }
    }
    const quote = quoteCache.get(asset) ?? null;
    if (quote && !quotes.some((item) => item.asset === quote.asset && item.source === quote.source)) quotes.push(quote);
    return quote;
  }

  const enriched: Position[] = [];
  for (const position of positions) {
    if (position.type === "wallet" || position.type === "supply") {
      const quote = await cachedQuote(position.asset.asset);
      if (!quote) {
        warnings.push(`No USD quote for ${position.type === "wallet" ? "wallet asset" : "supplied asset"} ${position.asset.asset}`);
        enriched.push(position);
        continue;
      }
      if (quote.source === "fixture") {
        warnings.push(`Refusing fixture USD quote for ${position.type === "wallet" ? "wallet asset" : "supplied asset"} ${position.asset.asset}`);
        enriched.push(position);
        continue;
      }
      enriched.push(withValue(position, "asset", atomicAmountToUsd(position.asset.amountAtomic, position.asset.decimals, quote.priceUsd), quote.meaning));
      continue;
    }
    if (position.type === "lending") {
      const legs = position.legs ?? { collateral: [position.collateral], debt: [position.debt] };
      const collateralLegs = [];
      const debtLegs = [];
      for (const leg of legs.collateral) {
        const quote = await cachedQuote(leg.asset);
        if (!quote) {
          warnings.push(`No USD quote for collateral ${leg.asset}`);
          collateralLegs.push(leg);
          continue;
        }
        if (quote.source === "fixture") {
          warnings.push(`Refusing fixture USD quote for collateral ${leg.asset} in fail-closed enrichment`);
          collateralLegs.push(leg);
          continue;
        }
        collateralLegs.push({
          ...leg,
          valueUsd: atomicAmountToUsd(leg.amountAtomic, leg.decimals, quote.priceUsd),
        });
      }
      for (const leg of legs.debt) {
        const quote = await cachedQuote(leg.asset);
        if (!quote) {
          warnings.push(`No USD quote for debt ${leg.asset}`);
          debtLegs.push(leg);
          continue;
        }
        if (quote.source === "fixture") {
          warnings.push(`Refusing fixture USD quote for debt ${leg.asset} in fail-closed enrichment`);
          debtLegs.push(leg);
          continue;
        }
        debtLegs.push({
          ...leg,
          valueUsd: atomicAmountToUsd(leg.amountAtomic, leg.decimals, quote.priceUsd),
        });
      }
      const collateralUsd = collateralLegs.every((leg) => leg.valueUsd !== null)
        ? collateralLegs.reduce((sum, leg) => sum + decimalToScaled(leg.valueUsd!), 0n)
        : null;
      const debtUsd = debtLegs.every((leg) => leg.valueUsd !== null)
        ? debtLegs.reduce((sum, leg) => sum + decimalToScaled(leg.valueUsd!), 0n)
        : null;
      const reason = collateralLegs[0]?.valueUsd
        ? `Valued ${collateralLegs.length} collateral / ${debtLegs.length} debt leg(s) via live price book.`
        : "Multi-asset lending legs partially unpriced.";
      let next: typeof position = {
        ...position,
        collateral: { ...collateralLegs[0]!, valueUsd: collateralUsd === null ? null : formatUsdFromScaled(collateralUsd, PRICE_SCALE) },
        debt: { ...debtLegs[0]!, valueUsd: debtUsd === null ? null : formatUsdFromScaled(debtUsd, PRICE_SCALE) },
        legs: { collateral: collateralLegs, debt: debtLegs },
        confidence: {
          ...position.confidence,
          reasons: position.confidence.reasons.includes(reason) ? position.confidence.reasons : [...position.confidence.reasons, reason],
        },
      };
      enriched.push(next);
      continue;
    }
    const token0Quote = await cachedQuote(position.token0.asset);
    const token1Quote = await cachedQuote(position.token1.asset);
    let next = position;
    if (token0Quote && token0Quote.source !== "fixture") {
      next = withValue(next, "token0", atomicAmountToUsd(position.token0.amountAtomic, position.token0.decimals, token0Quote.priceUsd), token0Quote.meaning) as typeof position;
    } else warnings.push(token0Quote?.source === "fixture"
      ? `Refusing fixture USD quote for LP token ${position.token0.asset}`
      : `No USD quote for LP token ${position.token0.asset}`);
    if (token1Quote && token1Quote.source !== "fixture") {
      next = withValue(next, "token1", atomicAmountToUsd(position.token1.amountAtomic, position.token1.decimals, token1Quote.priceUsd), token1Quote.meaning) as typeof position;
    } else warnings.push(token1Quote?.source === "fixture"
      ? `Refusing fixture USD quote for LP token ${position.token1.asset}`
      : `No USD quote for LP token ${position.token1.asset}`);
    enriched.push(next);
  }
  return { positions: enriched, warnings, quotes };
}
