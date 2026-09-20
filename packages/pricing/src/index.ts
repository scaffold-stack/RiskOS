import { stringAsciiCV, uintCV } from "@stacks/transactions";
import { z } from "zod";
import { asPrincipal, asTuple, asUint, tupleField, unwrapOk } from "../../adapters/src/clarity-values.js";
import { StacksReadOnlyClient } from "../../adapters/src/stacks-read-only-client.js";
import type { RegistryManifestProvider } from "../../adapters/src/registry-provider.js";
import { fetchWithDnsFallback, fetchWithRateLimitRetry, mapWithConcurrency } from "../../adapters/src/http-retry.js";
import { decimalToScaled, ratioToDecimal } from "../../domain/src/money.js";
import type { Position } from "../../domain/src/index.js";

export interface PriceQuote {
  asset: string;
  priceUsd: string;
  source: "dia" | "pyth" | "coingecko" | "coinbase" | "dia-pyth-consensus" | "multi-source-consensus" | "bitflow-market" | "stackingdao-rate" | "hermetica-rate" | "granite-rate" | "zest-vault" | "fixture";
  observedAt: string;
  ageSeconds: number | null;
  confidence: number;
  meaning: string;
}

export interface PriceBook {
  quote(asset: string): Promise<PriceQuote | null>;
}

const DIA_ORACLE = "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle";
/** Only structurally identical native assets may share an oracle key. */
const UNDERLYING_FOR_PRICE: Record<string, string> = {
  BTC: "BTC",
  sBTC: "BTC",
  "sBTC (protocol locked)": "BTC",
  STX: "STX",
  USDh: "USDH",
};
const DIA_KEYS: Record<string, string> = {
  BTC: "BTC/USD",
  STX: "STX/USD",
  USDH: "USDh/USD",
};
const PRICE_SCALE = 8;
const PYTH_FEEDS: Record<string, string> = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  STX: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1bd335c17",
  USDC: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
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
const ZEST_STRATEGY_TOKEN = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zvstBTC::zvstbtc";
const ZEST_STRATEGY_ENGINE = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zv-engine-stbtc-0";

export function resolvePriceUnderlying(asset: string): string {
  return UNDERLYING_FOR_PRICE[asset] ?? asset;
}

function formatUsdFromScaled(value: bigint, scale = PRICE_SCALE): string {
  return ratioToDecimal(value, 10n ** BigInt(scale), 2) ?? "0";
}

function formatPriceFromScaled(value: bigint, scale = PRICE_SCALE): string {
  return ratioToDecimal(value, 10n ** BigInt(scale), 8) ?? "0";
}

export function atomicAmountToUsd(amountAtomic: string, decimals: number, priceUsd: string): string {
  const amount = BigInt(amountAtomic);
  const price = decimalToScaled(priceUsd, PRICE_SCALE);
  const value = (amount * price) / 10n ** BigInt(decimals);
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
        const priceUsd = formatPriceFromScaled(value, PRICE_SCALE);
        const baseMeaning =
          ageSeconds <= this.maxAgeSeconds
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
    private readonly baseUrl = "https://pyth.dourolabs.app/hermes",
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
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "riskos/0.1",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        // Entitlement gaps are expected for optional Pyth; fail soft so the
        // remaining independent sources can still form a 2-of-N quorum.
        return null;
      }
      throw new Error(`Pyth Hermes latest-price request returned ${response.status}`);
    }
    const body = (await response.json()) as {
      parsed?: Array<{ id?: string; price?: { price?: string; expo?: number; publish_time?: number } }>;
    };
    const price = body.parsed?.find((item) => item.id?.replace(/^0x/, "") === feed)?.price;
    if (
      !price ||
      typeof price.price !== "string" ||
      !Number.isInteger(price.expo) ||
      !Number.isSafeInteger(price.publish_time)
    ) {
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

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  STX: "blockstack",
};
const coinGeckoPriceSchema = z.record(
  z.string(),
  z.object({
    usd: z.number().finite().positive(),
    last_updated_at: z.number().int().positive(),
  }).passthrough(),
);

/**
 * Free, independently operated market reference. This class never establishes
 * a trusted value on its own: production composes it behind the DIA divergence
 * gate, and fixed IDs prevent ticker-symbol ambiguity.
 */
export class CoinGeckoPriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();

  constructor(
    private readonly baseUrl = "https://api.coingecko.com/api/v3",
    private readonly demoApiKey?: string,
    private readonly maxAgeSeconds = 120,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const underlying = resolvePriceUnderlying(asset);
    const coinId = COINGECKO_IDS[underlying];
    if (!coinId) return null;
    const cached = this.cache.get(coinId);
    if (cached && cached.expiresAt > this.now().getTime()) return { ...cached.quote, asset };

    const url = new URL("/api/v3/simple/price", this.baseUrl);
    // Fetch the complete fixed allowlist in one request. This avoids spending
    // the keyless public quota once per wallet asset and gives BTC/STX the same
    // provider observation window.
    url.searchParams.set("ids", [...new Set(Object.values(COINGECKO_IDS))].join(","));
    url.searchParams.set("vs_currencies", "usd");
    url.searchParams.set("include_last_updated_at", "true");
    url.searchParams.set("precision", "full");
    const response = await fetchWithRateLimitRetry(this.request, url, {
      headers: {
        accept: "application/json",
        "user-agent": "riskos/0.1",
        ...(this.demoApiKey ? { "x-cg-demo-api-key": this.demoApiKey } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`CoinGecko simple-price request returned ${response.status}`);
    const rows = coinGeckoPriceSchema.parse(await response.json());
    for (const [marketAsset, marketId] of Object.entries(COINGECKO_IDS)) {
      const row = rows[marketId];
      if (!row) continue;
      const observedAt = new Date(row.last_updated_at * 1_000).toISOString();
      const ageSeconds = Math.max(0, Math.floor((this.now().getTime() - row.last_updated_at * 1_000) / 1_000));
      const quote: PriceQuote = {
        asset: marketAsset,
        priceUsd: row.usd.toString(),
        source: "coingecko",
        observedAt,
        ageSeconds,
        confidence: ageSeconds <= this.maxAgeSeconds ? 0.88 : 0.4,
        meaning: `CoinGecko fixed market ${marketId}/USD = $${row.usd} (${ageSeconds}s old).`,
      };
      this.cache.set(marketId, { quote, expiresAt: this.now().getTime() + 20_000 });
    }
    const loaded = this.cache.get(coinId)?.quote;
    if (!loaded) throw new Error(`CoinGecko response omitted the fixed ${coinId} market`);
    return { ...loaded, asset };
  }
}

const COINBASE_PRODUCTS: Record<string, string> = {
  BTC: "BTC-USD",
  STX: "STX-USD",
  USDC: "USDC-USD",
};
const coinbaseTickerSchema = z.object({
  price: z.string().regex(/^\d+(?:\.\d+)?$/),
  time: z.string().datetime(),
});

/**
 * Independent, unauthenticated USD market observation from Coinbase Exchange.
 * Fixed product IDs prevent ticker ambiguity. It is only ever consumed by the
 * quorum and cannot establish a production value on its own.
 */
export class CoinbaseExchangePriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();
  private readonly loads = new Map<string, Promise<PriceQuote>>();

  constructor(
    private readonly baseUrl = "https://api.exchange.coinbase.com",
    private readonly maxAgeSeconds = 120,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const underlying = resolvePriceUnderlying(asset);
    const product = COINBASE_PRODUCTS[underlying];
    if (!product) return null;
    const cached = this.cache.get(product);
    if (cached && cached.expiresAt > this.now().getTime()) return { ...cached.quote, asset };

    let load = this.loads.get(product);
    if (!load) {
      load = (async () => {
        const response = await fetchWithDnsFallback(
          this.request,
          `${this.baseUrl.replace(/\/$/, "")}/products/${product}/ticker`,
          { headers: { accept: "application/json", "user-agent": "riskos/0.1" } },
        );
        if (!response.ok) throw new Error(`Coinbase Exchange ${product} ticker returned ${response.status}`);
        const ticker = coinbaseTickerSchema.parse(await response.json());
        const timestamp = Date.parse(ticker.time);
        const ageSeconds = Math.max(0, Math.floor((this.now().getTime() - timestamp) / 1_000));
        const quote: PriceQuote = {
          asset: underlying,
          priceUsd: ticker.price,
          source: "coinbase",
          observedAt: new Date(timestamp).toISOString(),
          ageSeconds,
          confidence: ageSeconds <= this.maxAgeSeconds ? 0.88 : 0.4,
          meaning: `Coinbase Exchange fixed ${product} last trade = $${ticker.price} (${ageSeconds}s old).`,
        };
        this.cache.set(product, { quote, expiresAt: this.now().getTime() + 20_000 });
        return quote;
      })();
      this.loads.set(product, load);
    }
    try {
      return { ...(await load), asset };
    } finally {
      if (this.loads.get(product) === load) this.loads.delete(product);
    }
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
    // The reference is selected per market: fresh entitled Pyth first, then
    // CoinGecko. Either path still has to agree with DIA below.
    const reference = await this.reference.quote(asset);
    if (!reference || reference.source === "fixture") return null;
    const primaryScaled = decimalToScaled(primary.priceUsd, PRICE_SCALE);
    const referenceScaled = decimalToScaled(reference.priceUsd, PRICE_SCALE);
    if (primaryScaled <= 0n || referenceScaled <= 0n) return null;
    const delta =
      primaryScaled > referenceScaled ? primaryScaled - referenceScaled : referenceScaled - primaryScaled;
    const divergenceBps = Number((delta * 10_000n) / primaryScaled);
    if (divergenceBps > this.maximumDivergenceBps) return null;
    const pythReference = reference.source === "pyth";
    const referenceLabel = pythReference
      ? "Pyth"
      : reference.source === "coingecko"
        ? "CoinGecko"
        : reference.source;
    return {
      asset,
      priceUsd: formatPriceFromScaled((primaryScaled + referenceScaled) / 2n, PRICE_SCALE),
      source: pythReference ? "dia-pyth-consensus" : "multi-source-consensus",
      observedAt: new Date(
        Math.min(Date.parse(primary.observedAt), Date.parse(reference.observedAt)),
      ).toISOString(),
      ageSeconds: Math.max(primary.ageSeconds ?? 0, reference.ageSeconds ?? 0),
      confidence: Math.min(primary.confidence, reference.confidence),
      meaning: `DIA and ${referenceLabel} independently reported prices within ${divergenceBps} bps (maximum ${this.maximumDivergenceBps}); midpoint used. DIA: ${primary.meaning} ${referenceLabel}: ${reference.meaning}`,
    };
  }
}

/**
 * Selects the largest mutually agreeing cluster of fresh, non-fixture quotes.
 * One unavailable or outlying provider cannot veto two independent providers
 * that agree. A single provider can never establish a production valuation.
 */
export class QuorumPriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();
  private readonly loads = new Map<string, Promise<PriceQuote | null>>();

  constructor(
    private readonly sources: PriceBook[],
    private readonly minimumSources = 2,
    private readonly maximumDivergenceBps = 150,
    private readonly minimumConfidence = 0.7,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const underlying = resolvePriceUnderlying(asset);
    const cached = this.cache.get(underlying);
    if (cached && cached.expiresAt > this.now().getTime()) return this.aliasQuote(cached.quote, asset, underlying);
    let load = this.loads.get(underlying);
    if (!load) {
      load = this.resolveQuorum(underlying);
      this.loads.set(underlying, load);
    }
    try {
      const quote = await load;
      if (!quote) return null;
      // One portfolio pass can involve several protocol and receipt-token
      // reads. Keep the accepted market observation long enough for every leg
      // in that pass to use the same quorum instead of racing provider refreshes.
      this.cache.set(underlying, { quote, expiresAt: this.now().getTime() + 120_000 });
      return this.aliasQuote(quote, asset, underlying);
    } finally {
      if (this.loads.get(underlying) === load) this.loads.delete(underlying);
    }
  }

  private aliasQuote(quote: PriceQuote, asset: string, underlying: string): PriceQuote {
    if (asset === underlying) return quote;
    return {
      ...quote,
      asset,
      confidence: Math.min(quote.confidence, 0.75),
      meaning: `${asset} priced 1:1 to ${underlying} from the accepted market quorum. ${quote.meaning}`,
    };
  }

  private async resolveQuorum(asset: string): Promise<PriceQuote | null> {
    const settled = await Promise.allSettled(this.sources.map((source) => source.quote(asset)));
    const candidates = settled.flatMap((result) => {
      if (result.status !== "fulfilled" || !result.value) return [];
      const quote = result.value;
      if (quote.source === "fixture" || quote.confidence < this.minimumConfidence) return [];
      try {
        const scaled = decimalToScaled(quote.priceUsd, PRICE_SCALE);
        return scaled > 0n ? [{ quote, scaled }] : [];
      } catch {
        return [];
      }
    });
    if (candidates.length < this.minimumSources) return null;

    const clusters: typeof candidates[] = [];
    for (let mask = 1; mask < 1 << candidates.length; mask += 1) {
      const cluster = candidates.filter((_, index) => (mask & (1 << index)) !== 0);
      if (cluster.length < this.minimumSources) continue;
      const agrees = cluster.every((left, leftIndex) =>
        cluster.slice(leftIndex + 1).every((right) => {
          const delta = left.scaled > right.scaled ? left.scaled - right.scaled : right.scaled - left.scaled;
          return Number((delta * 10_000n) / left.scaled) <= this.maximumDivergenceBps;
        }),
      );
      if (agrees) clusters.push(cluster);
    }
    const selected = clusters.sort((left, right) => {
      if (right.length !== left.length) return right.length - left.length;
      const leftConfidence = left.reduce((sum, item) => sum + item.quote.confidence, 0);
      const rightConfidence = right.reduce((sum, item) => sum + item.quote.confidence, 0);
      return rightConfidence - leftConfidence;
    })[0];
    if (!selected) return null;

    const ordered = selected.map((item) => item.scaled).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const midpoint = ordered.length % 2 === 1
      ? ordered[Math.floor(ordered.length / 2)]!
      : (ordered[ordered.length / 2 - 1]! + ordered[ordered.length / 2]!) / 2n;
    const sourceNames = selected.map((item) => item.quote.source);
    const selectedSet = new Set(selected.map((item) => item.quote));
    const excluded = candidates.filter((item) => !selectedSet.has(item.quote)).map((item) => item.quote.source);
    const diaPythOnly = selected.length === 2 && sourceNames.includes("dia") && sourceNames.includes("pyth");
    return {
      asset,
      priceUsd: formatPriceFromScaled(midpoint, PRICE_SCALE),
      source: diaPythOnly ? "dia-pyth-consensus" : "multi-source-consensus",
      observedAt: new Date(Math.min(...selected.map((item) => Date.parse(item.quote.observedAt)))).toISOString(),
      ageSeconds: Math.max(...selected.map((item) => item.quote.ageSeconds ?? 0)),
      confidence: Math.min(...selected.map((item) => item.quote.confidence)),
      meaning: `${selected.length}-of-${this.sources.length} price quorum accepted ${sourceNames.join(" + ")} within ${this.maximumDivergenceBps} bps; median used.${excluded.length ? ` Excluded outlier(s): ${excluded.join(", ")}.` : ""} ${selected.map((item) => `${item.quote.source}: ${item.quote.meaning}`).join(" ")}`,
    };
  }
}

const bitflowActiveBinSchema = z
  .object({
    success: z.literal(true),
    price: z.string().regex(/^\d+$/),
    applied_block_height: z.number().int().nonnegative(),
  })
  .passthrough();
const bitflowQuotePoolsSchema = z.object({
  pools: z.array(z.object({
    pool_id: z.string(),
    pool_token: z.string(),
    token_x: z.string(),
    token_y: z.string(),
  }).passthrough()),
}).passthrough();

/** Prices USDCx from the registry-approved Bitflow sBTC/USDCx market and a live BTC/USD oracle. */
export class BitflowMarketPriceBook implements PriceBook {
  private cache: { expiresAt: number; quote: PriceQuote } | null = null;
  private load: Promise<PriceQuote | null> | null = null;

  constructor(
    private readonly fallback: PriceBook,
    private readonly registry: RegistryManifestProvider,
    private readonly _appApiUrl = "https://bff.bitflowapis.finance/api/app",
    private readonly quotesApiUrl = "https://bff.bitflowapis.finance/api/quotes",
    private readonly maximumPegDivergenceBps = 500,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    if (asset !== "USDCx") return this.fallback.quote(asset);
    if (this.cache && this.cache.expiresAt > this.now().getTime()) return this.cache.quote;
    if (this.load) return this.load;
    const load = this.resolveQuote(asset);
    this.load = load;
    try {
      return await load;
    } finally {
      if (this.load === load) this.load = null;
    }
  }

  private async resolveQuote(asset: string): Promise<PriceQuote | null> {
    const manifest = await this.registry();
    const allowedPools = manifest?.entries
      .filter((entry) => entry.enabled && entry.protocol === "bitflow" && entry.supportedAssets.includes("sBTC") && entry.supportedAssets.includes("USDCx")) ?? [];
    const sbtcContract = manifest?.entries.find((entry) => entry.enabled && entry.protocol === "sbtc")?.contractPrincipal;
    if (allowedPools.length === 0 || !sbtcContract) return null;
    // The app API is an availability dependency for portfolio discovery, but it
    // is not needed for valuation. The quote registry contains the canonical
    // pool contract, quote ID and token ordering and remains independently
    // usable when the app API is slow or unavailable.
    const poolsResponse = await fetchWithRateLimitRetry(this.request, `${this.quotesApiUrl.replace(/\/$/, "")}/v1/pools`, {
      headers: { accept: "application/json", "user-agent": "riskos/0.1" },
    }, 12_000);
    if (!poolsResponse.ok) throw new Error(`Bitflow quote-pool discovery returned ${poolsResponse.status}`);
    const pool = bitflowQuotePoolsSchema.parse(await poolsResponse.json()).pools.find((item) =>
      allowedPools.some((entry) => entry.contractPrincipal === item.pool_token) &&
      (item.token_x === sbtcContract || item.token_y === sbtcContract));
    if (!pool) return null;
    const quotePoolId = pool.pool_id;
    const activeResponse = await fetchWithRateLimitRetry(
      this.request,
      `${this.quotesApiUrl.replace(/\/$/, "")}/v1/bins/${encodeURIComponent(quotePoolId)}/active`,
      {
        headers: { accept: "application/json", "user-agent": "riskos/0.1" },
      },
      12_000,
    );
    if (!activeResponse.ok) throw new Error(`Bitflow active-bin quote returned ${activeResponse.status}`);
    const active = bitflowActiveBinSchema.parse(await activeResponse.json());
    const rawPrice = BigInt(active.price);
    if (rawPrice <= 0n) return null;
    const btc = await this.fallback.quote("sBTC");
    if (!btc || btc.source === "fixture") return null;
    const btcUsd = decimalToScaled(btc.priceUsd, PRICE_SCALE);
    const poolPrice = (rawPrice * 10n ** BigInt(PRICE_SCALE)) / 1_000_000n;
    const usdcUsd =
      pool.token_x === sbtcContract
        ? (btcUsd * 10n ** BigInt(PRICE_SCALE)) / poolPrice
        : (btcUsd * poolPrice) / 10n ** BigInt(PRICE_SCALE);
    const oneDollar = 10n ** BigInt(PRICE_SCALE);
    const divergence = usdcUsd > oneDollar ? usdcUsd - oneDollar : oneDollar - usdcUsd;
    const divergenceBps = Number((divergence * 10_000n) / oneDollar);
    if (divergenceBps > this.maximumPegDivergenceBps) return null;
    const quote: PriceQuote = {
      asset,
      priceUsd: ratioToDecimal(usdcUsd, oneDollar, 6) ?? "0",
      source: "bitflow-market",
      observedAt: btc.observedAt,
      ageSeconds: btc.ageSeconds,
      confidence: Math.min(0.88, btc.confidence),
      meaning: `Registry-approved Bitflow ${pool.pool_token} (${quotePoolId}) active bin at block ${active.applied_block_height}, anchored to ${btc.source} BTC/USD; ${divergenceBps} bps from $1.`,
    };
    this.cache = { expiresAt: this.now().getTime() + 30_000, quote };
    return quote;
  }
}

const PROTOCOL_STABLE_ASSETS: Record<string, { canonical: "USDH" | "aeUSDC"; decimals: number }> = {
  USDH: { canonical: "USDH", decimals: 8 },
  USDh: { canonical: "USDH", decimals: 8 },
  aeUSDC: { canonical: "aeUSDC", decimals: 6 },
};

/**
 * Derives an executable stablecoin market value from a registry-approved
 * Bitflow pool against already-verified USDCx. This is market evidence, not a
 * hard-coded $1 peg.
 */
export class BitflowStablecoinMarketPriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();
  private readonly loads = new Map<string, Promise<PriceQuote | null>>();

  constructor(
    private readonly fallback: PriceBook,
    private readonly registry: RegistryManifestProvider,
    private readonly quotesApiUrl = "https://bff.bitflowapis.finance/api/quotes",
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const definition = PROTOCOL_STABLE_ASSETS[asset];
    if (!definition) return this.fallback.quote(asset);
    const cached = this.cache.get(definition.canonical);
    if (cached && cached.expiresAt > this.now().getTime()) return { ...cached.quote, asset };
    let load = this.loads.get(definition.canonical);
    if (!load) {
      load = this.resolveQuote(definition.canonical);
      this.loads.set(definition.canonical, load);
    }
    try {
      const quote = await load;
      return quote ? { ...quote, asset } : null;
    } finally {
      if (this.loads.get(definition.canonical) === load) this.loads.delete(definition.canonical);
    }
  }

  private async resolveQuote(asset: "USDH" | "aeUSDC"): Promise<PriceQuote | null> {
    const definition = PROTOCOL_STABLE_ASSETS[asset]!;

    const manifest = await this.registry();
    const targetDefinition = manifest?.entries
      .filter((entry) => entry.enabled)
      .flatMap((entry) => entry.assetDefinitions)
      .find((item) => item.symbol === definition.canonical);
    const targetContract = targetDefinition?.assetIdentifier.slice(0, targetDefinition.assetIdentifier.lastIndexOf("::"));
    const target = manifest?.entries.find(
      (entry) => entry.enabled && entry.contractPrincipal === targetContract,
    );
    const usdcx = manifest?.entries.find(
      (entry) =>
        entry.enabled && entry.protocol === "usdcx" &&
        entry.assetDefinitions.some((item) => item.symbol === "USDCx"),
    );
    const allowedPools = manifest?.entries.filter(
      (entry) =>
        entry.enabled && entry.protocol === "bitflow" &&
        entry.supportedAssets.includes(definition.canonical) && entry.supportedAssets.includes("USDCx"),
    ) ?? [];
    if (!target || !usdcx || allowedPools.length === 0) return null;

    const poolsResponse = await fetchWithRateLimitRetry(this.request, `${this.quotesApiUrl.replace(/\/$/, "")}/v1/pools`, {
      headers: { accept: "application/json", "user-agent": "riskos/0.1" },
    }, 12_000);
    if (!poolsResponse.ok) throw new Error(`Bitflow stable-pool discovery returned ${poolsResponse.status}`);
    const pool = bitflowQuotePoolsSchema.parse(await poolsResponse.json()).pools.find(
      (item) =>
        allowedPools.some((entry) => entry.contractPrincipal === item.pool_token) &&
        [item.token_x, item.token_y].includes(target.contractPrincipal) &&
        [item.token_x, item.token_y].includes(usdcx.contractPrincipal),
    );
    if (!pool) return null;
    const activeResponse = await fetchWithRateLimitRetry(
      this.request,
      `${this.quotesApiUrl.replace(/\/$/, "")}/v1/bins/${encodeURIComponent(pool.pool_id)}/active`,
      {
        headers: { accept: "application/json", "user-agent": "riskos/0.1" },
      },
      12_000,
    );
    if (!activeResponse.ok) throw new Error(`Bitflow ${definition.canonical}/USDCx active-bin quote returned ${activeResponse.status}`);
    const active = bitflowActiveBinSchema.parse(await activeResponse.json());
    const raw = BigInt(active.price);
    if (raw <= 0n) return null;
    const usdcxQuote = await this.fallback.quote("USDCx");
    if (!usdcxQuote || usdcxQuote.source === "fixture") return null;
    const usdcxUsd = decimalToScaled(usdcxQuote.priceUsd, PRICE_SCALE);
    const exponent = PRICE_SCALE + 6 - definition.decimals;
    if (exponent < 0) throw new Error("Bitflow stablecoin price scale is unsupported");
    const priceScale = 10n ** BigInt(exponent);
    const price = pool.token_x === target.contractPrincipal
      ? (usdcxUsd * raw) / priceScale
      : (usdcxUsd * priceScale) / raw;
    if (price <= 0n) return null;
    const quote: PriceQuote = {
      asset,
      priceUsd: formatPriceFromScaled(price, PRICE_SCALE),
      source: "bitflow-market",
      observedAt: usdcxQuote.observedAt,
      ageSeconds: usdcxQuote.ageSeconds,
      confidence: Math.min(0.86, usdcxQuote.confidence),
      meaning: `Registry-approved Bitflow ${pool.pool_token} (${pool.pool_id}) active bin at block ${active.applied_block_height} values ${definition.canonical} against verified USDCx; USDCx evidence: ${usdcxQuote.meaning}`,
    };
    this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
    return quote;
  }
}

/** Requires protocol-stablecoin market evidence to agree with an independent USD reference. */
export class ProtocolStablecoinConsensusPriceBook implements PriceBook {
  constructor(
    private readonly fallback: PriceBook,
    private readonly market: PriceBook,
    private readonly dia: PriceBook,
    private readonly usdReference: PriceBook,
    private readonly maximumDivergenceBps = 150,
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const definition = PROTOCOL_STABLE_ASSETS[asset];
    if (!definition) return this.fallback.quote(asset);
    const [market, referenceRaw] = await Promise.all([
      this.market.quote(definition.canonical),
      definition.canonical === "USDH" ? this.dia.quote("USDH") : this.usdReference.quote("USDC"),
    ]);
    if (!market || !referenceRaw || market.source === "fixture" || referenceRaw.source === "fixture") return null;
    const marketScaled = decimalToScaled(market.priceUsd, PRICE_SCALE);
    const referenceScaled = decimalToScaled(referenceRaw.priceUsd, PRICE_SCALE);
    if (marketScaled <= 0n || referenceScaled <= 0n) return null;
    const delta = marketScaled > referenceScaled ? marketScaled - referenceScaled : referenceScaled - marketScaled;
    const divergenceBps = Number((delta * 10_000n) / referenceScaled);
    if (divergenceBps > this.maximumDivergenceBps) return null;
    return {
      asset,
      priceUsd: formatPriceFromScaled((marketScaled + referenceScaled) / 2n, PRICE_SCALE),
      source: "multi-source-consensus",
      observedAt: new Date(Math.min(Date.parse(market.observedAt), Date.parse(referenceRaw.observedAt))).toISOString(),
      ageSeconds: Math.max(market.ageSeconds ?? 0, referenceRaw.ageSeconds ?? 0),
      confidence: Math.min(market.confidence, referenceRaw.confidence),
      meaning: `${definition.canonical} market value and independent ${definition.canonical === "USDH" ? "DIA USDh/USD" : "Coinbase USDC/USD"} reference agree within ${divergenceBps} bps (maximum ${this.maximumDivergenceBps}); midpoint used. Market: ${market.meaning} Reference: ${referenceRaw.meaning}`,
    };
  }
}

export class HermeticaExchangeRatePriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();

  constructor(
    private readonly underlyingPrices: PriceBook,
    private readonly client: StacksReadOnlyClient,
    private readonly registry: RegistryManifestProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    if (asset !== "sUSDh") return this.underlyingPrices.quote(asset);
    const cached = this.cache.get(asset);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.quote;
    const manifest = await this.registry();
    const staking = manifest?.entries.find(
      (entry) => entry.enabled && entry.protocol === "hermetica" && entry.contractPrincipal.endsWith(".staking-v1-1"),
    );
    if (!staking?.readOnlyFunctions.includes("get-usdh-per-susdh")) return null;
    const usdh = await this.underlyingPrices.quote("USDH");
    if (!usdh || usdh.source === "fixture") return null;
    const pinned = await this.client.pinTip();
    const ratio = asUint(unwrapOk(await pinned.call(staking.contractPrincipal, "get-usdh-per-susdh", [])));
    if (ratio === 0n) return null;
    const price = (decimalToScaled(usdh.priceUsd, PRICE_SCALE) * ratio) / 100_000_000n;
    const quote: PriceQuote = {
      asset,
      priceUsd: formatPriceFromScaled(price, PRICE_SCALE),
      source: "hermetica-rate",
      observedAt: usdh.observedAt,
      ageSeconds: usdh.ageSeconds,
      confidence: Math.min(0.9, usdh.confidence),
      meaning: `1 sUSDh = ${ratioToDecimal(ratio, 100_000_000n, 8)} USDh via ${staking.contractPrincipal}.get-usdh-per-susdh at Stacks block ${pinned.blockHeight}; USDh price: ${usdh.meaning}`,
    };
    this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
    return quote;
  }
}

export class GraniteExchangeRatePriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();

  constructor(
    private readonly underlyingPrices: PriceBook,
    private readonly client: StacksReadOnlyClient,
    private readonly registry: RegistryManifestProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    if (asset !== "gUSDC") return this.underlyingPrices.quote(asset);
    const cached = this.cache.get(asset);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.quote;
    const manifest = await this.registry();
    const state = manifest?.entries.find(
      (entry) => entry.enabled && entry.protocol === "granite" && entry.contractPrincipal.endsWith(".state-v1"),
    );
    if (!state?.readOnlyFunctions.includes("convert-to-assets")) return null;
    const aeUsdc = await this.underlyingPrices.quote("aeUSDC");
    if (!aeUsdc || aeUsdc.source === "fixture") return null;
    const pinned = await this.client.pinTip();
    const assets = asUint(await pinned.call(state.contractPrincipal, "convert-to-assets", [uintCV(1_000_000n)]));
    if (assets === 0n) return null;
    const price = (decimalToScaled(aeUsdc.priceUsd, PRICE_SCALE) * assets) / 1_000_000n;
    const quote: PriceQuote = {
      asset,
      priceUsd: formatPriceFromScaled(price, PRICE_SCALE),
      source: "granite-rate",
      observedAt: aeUsdc.observedAt,
      ageSeconds: aeUsdc.ageSeconds,
      confidence: Math.min(0.9, aeUsdc.confidence),
      meaning: `1 gUSDC = ${ratioToDecimal(assets, 1_000_000n, 6)} aeUSDC via ${state.contractPrincipal}.convert-to-assets at Stacks block ${pinned.blockHeight}; aeUSDC price: ${aeUsdc.meaning}`,
    };
    this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
    return quote;
  }
}

/**
 * Values Zest vault receipts with the deployed vault's conversion function at
 * one pinned Stacks tip. The underlying price still retains its own source and
 * confidence semantics (DIA or a verified market quote).
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
    if (asset === "zvstBTC") return this.quoteStrategyVault(asset);
    const conversion = ZEST_RECEIPT_VAULTS[asset];
    if (!conversion) return this.underlyingPrices.quote(asset);
    const cached = this.cache.get(asset);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.quote;

    const manifest = await this.registry();
    const vault = manifest?.entries.find(
      (entry) =>
        entry.enabled &&
        entry.network === "mainnet" &&
        entry.protocol === "zest-v2" &&
        entry.contractPrincipal.endsWith(`.${conversion.vault}`),
    );
    if (!vault) return null;
    const requiredFunctions = ["get-underlying", "get-decimals", "convert-to-assets"];
    if (requiredFunctions.some((name) => !vault.readOnlyFunctions.includes(name))) return null;
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
    const underlyingAtomic = asUint(
      unwrapOk(await pinned.call(vault.contractPrincipal, "convert-to-assets", [uintCV(oneShare)])),
    );
    const basePrice = decimalToScaled(underlying.priceUsd, PRICE_SCALE);
    const receiptPrice = (basePrice * underlyingAtomic) / 10n ** underlyingDecimals;
    const priceUsd = formatPriceFromScaled(receiptPrice, PRICE_SCALE);
    const quote: PriceQuote = {
      asset,
      priceUsd,
      source: "zest-vault",
      observedAt: underlying.observedAt,
      ageSeconds: underlying.ageSeconds,
      confidence: Math.min(0.9, underlying.confidence),
      meaning: `${asset} = ${ratioToDecimal(underlyingAtomic, 10n ** underlyingDecimals, 8)} ${conversion.underlying} via ${vault.contractPrincipal}.convert-to-assets at Stacks block ${pinned.blockHeight}; underlying price: ${underlying.meaning}`,
    };
    this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
    return quote;
  }

  private async quoteStrategyVault(asset: "zvstBTC"): Promise<PriceQuote | null> {
    const cached = this.cache.get(asset);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.quote;
    const manifest = await this.registry();
    const approved = manifest?.entries.some((entry) =>
      entry.enabled &&
      entry.network === "mainnet" &&
      entry.protocol === "zest-v2" &&
      entry.assetDefinitions.some((definition) => definition.assetIdentifier === ZEST_STRATEGY_TOKEN),
    );
    if (!approved) return null;
    const underlying = await this.underlyingPrices.quote("stBTC");
    if (!underlying || underlying.source === "fixture") return null;
    const pinned = await this.client.pinTip();
    const underlyingAtomic = asUint(
      unwrapOk(await pinned.call(ZEST_STRATEGY_ENGINE, "convert-to-assets", [uintCV(100_000_000n)])),
    );
    if (underlyingAtomic === 0n) return null;
    const receiptPrice = (decimalToScaled(underlying.priceUsd, PRICE_SCALE) * underlyingAtomic) / 100_000_000n;
    const quote: PriceQuote = {
      asset,
      priceUsd: formatPriceFromScaled(receiptPrice, PRICE_SCALE),
      source: "zest-vault",
      observedAt: underlying.observedAt,
      ageSeconds: underlying.ageSeconds,
      confidence: Math.min(0.9, underlying.confidence),
      meaning: `1 zvstBTC redeems to ${ratioToDecimal(underlyingAtomic, 100_000_000n, 8)} stBTC via ${ZEST_STRATEGY_ENGINE}.convert-to-assets at Stacks block ${pinned.blockHeight}; underlying price: ${underlying.meaning}`,
    };
    this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
    return quote;
  }
}

const STACKINGDAO_STSTXBTC_CORE =
  "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.stacking-dao-core-ststxbtc-v2";

/**
 * Values StackingDAO receipt assets from their deployed protocol semantics.
 * stSTX has an appreciating on-chain exchange rate. stSTXbtc is deliberately
 * different: the deployed core mints and queues withdrawals 1:1 in STX while
 * distributing its sBTC rewards separately, so its backing value stays 1 STX.
 */
export class StackingDaoExchangeRatePriceBook implements PriceBook {
  private readonly cache = new Map<string, { quote: PriceQuote; expiresAt: number }>();

  constructor(
    private readonly underlyingPrices: PriceBook,
    private readonly client: StacksReadOnlyClient,
    private readonly registry: RegistryManifestProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    if (asset !== "stSTX" && asset !== "stSTXbtc" && asset !== "stBTC") {
      return this.underlyingPrices.quote(asset);
    }
    const cached = this.cache.get(asset);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.quote;

    if (asset === "stBTC") {
      const manifest = await this.registry();
      const rateContract = manifest?.entries.find((entry) =>
        entry.enabled &&
        entry.protocol === "stackingdao" &&
        entry.supportedAssets.includes("stBTC") &&
        entry.contractPrincipal.endsWith(".data-stbtc-v1"),
      );
      if (!rateContract?.readOnlyFunctions.includes("get-sbtc-per-stbtc")) return null;
      const sbtc = await this.underlyingPrices.quote("sBTC");
      if (!sbtc || sbtc.source === "fixture") return null;
      const pinned = await this.client.pinTip();
      const rate = asUint(await pinned.call(rateContract.contractPrincipal, "get-sbtc-per-stbtc", []));
      if (rate === 0n) return null;
      const sbtcPrice = decimalToScaled(sbtc.priceUsd, PRICE_SCALE);
      const priceUsd = formatPriceFromScaled((sbtcPrice * rate) / 100_000_000n, PRICE_SCALE);
      const quote: PriceQuote = {
        asset,
        priceUsd,
        source: "stackingdao-rate",
        observedAt: sbtc.observedAt,
        ageSeconds: sbtc.ageSeconds,
        confidence: Math.min(0.9, sbtc.confidence),
        meaning: `1 stBTC = ${ratioToDecimal(rate, 100_000_000n, 8)} sBTC via ${rateContract.contractPrincipal}.get-sbtc-per-stbtc at Stacks block ${pinned.blockHeight}; sBTC price: ${sbtc.meaning}`,
      };
      this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
      return quote;
    }

    const stx = await this.underlyingPrices.quote("STX");
    if (!stx || stx.source === "fixture") return null;

    if (asset === "stSTXbtc") {
      const quote: PriceQuote = {
        asset,
        priceUsd: stx.priceUsd,
        source: "stackingdao-rate",
        observedAt: stx.observedAt,
        ageSeconds: stx.ageSeconds,
        confidence: Math.min(0.9, stx.confidence),
        meaning: `1 stSTXbtc has 1 STX protocol backing: the deployed ${STACKINGDAO_STSTXBTC_CORE} mints stSTXbtc 1:1 on deposit and records the same STX amount for queued withdrawal; sBTC rewards are distributed separately. This is backing value, not a DEX exit quote. STX price: ${stx.meaning}`,
      };
      this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
      return quote;
    }

    const manifest = await this.registry();
    const rateContract = manifest?.entries.find((entry) =>
      entry.enabled && entry.protocol === "stackingdao" && entry.contractPrincipal.endsWith(".data-stx-v2"));
    if (!rateContract?.readOnlyFunctions.includes("get-stx-per-ststx")) return null;
    const pinned = await this.client.pinTip();
    const rate = asUint(await pinned.call(rateContract.contractPrincipal, "get-stx-per-ststx", []));
    if (rate === 0n) return null;
    const stxPrice = decimalToScaled(stx.priceUsd, PRICE_SCALE);
    const priceUsd = formatPriceFromScaled((stxPrice * rate) / 1_000_000n, PRICE_SCALE);
    const quote: PriceQuote = {
      asset,
      priceUsd,
      source: "stackingdao-rate",
      observedAt: stx.observedAt,
      ageSeconds: stx.ageSeconds,
      confidence: Math.min(0.9, stx.confidence),
      meaning: `1 stSTX = ${ratioToDecimal(rate, 1_000_000n, 6)} STX via ${rateContract.contractPrincipal}.get-stx-per-ststx at Stacks block ${pinned.blockHeight}; STX price: ${stx.meaning}`,
    };
    this.cache.set(asset, { quote, expiresAt: this.now().getTime() + 30_000 });
    return quote;
  }
}

export class StaticFallbackPriceBook implements PriceBook {
  constructor(
    private readonly prices: Record<string, string>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    const underlying = resolvePriceUnderlying(asset);
    const priceUsd = this.prices[underlying] ?? this.prices[asset];
    if (!priceUsd) return null;
    const aliased = asset !== underlying;
    return {
      asset,
      priceUsd,
      source: "fixture",
      observedAt: this.now().toISOString(),
      ageSeconds: null,
      confidence: aliased ? 0.35 : 0.4,
      meaning: aliased
        ? `Fallback $${priceUsd} for ${asset} via 1:1 ${underlying}. Prefer DIA + exchange-rate when available.`
        : `Fallback reference price $${priceUsd} for ${asset}. Prefer DIA when available.`,
    };
  }
}

export class CompositePriceBook implements PriceBook {
  constructor(
    private readonly primary: PriceBook,
    private readonly fallback?: PriceBook,
    private readonly minimumPrimaryConfidence = 0.7,
  ) {}

  async quote(asset: string): Promise<PriceQuote | null> {
    try {
      const primary = await this.primary.quote(asset);
      if (
        primary &&
        primary.source !== "fixture" &&
        primary.confidence >= this.minimumPrimaryConfidence
      ) return primary;
    } catch {
      // fall through
    }
    return this.fallback ? this.fallback.quote(asset) : null;
  }
}

function withValue(
  position: Position,
  assetField: "asset" | "collateral" | "debt" | "token0" | "token1",
  valueUsd: string | null,
  quote: PriceQuote,
): Position {
  const valuation = {
    priceUsd: quote.priceUsd,
    source: quote.source,
    observedAt: quote.observedAt,
    ageSeconds: quote.ageSeconds,
    confidence: quote.confidence,
    meaning: quote.meaning,
  };
  const reason = quote.meaning;
  const confidence = {
    ...position.confidence,
    state: quote.confidence >= 0.8 ? position.confidence.state : ("estimated" as const),
    score: Math.min(position.confidence.score, quote.confidence),
    reasons: position.confidence.reasons.includes(reason)
      ? position.confidence.reasons
      : [...position.confidence.reasons, reason],
  };
  if ((position.type === "wallet" || position.type === "supply") && assetField === "asset") {
    return {
      ...position,
      asset: { ...position.asset, valueUsd, valuation },
      confidence,
    };
  }
  if (position.type === "lending" && (assetField === "collateral" || assetField === "debt")) {
    return {
      ...position,
      [assetField]: { ...position[assetField], valueUsd, valuation },
      confidence,
    } as Position;
  }
  if (position.type === "liquidity" && (assetField === "token0" || assetField === "token1")) {
    return {
      ...position,
      [assetField]: { ...position[assetField], valueUsd, valuation },
      confidence,
    } as Position;
  }
  return position;
}

function withValuationUnavailable(position: Position, reason: string): Position {
  return {
    ...position,
    confidence: {
      ...position.confidence,
      state: position.confidence.state === "unsupported" ? "unsupported" : "degraded",
      score: Math.min(position.confidence.score, 0.5),
      reasons: position.confidence.reasons.includes(reason)
        ? position.confidence.reasons
        : [...position.confidence.reasons, reason],
    },
  };
}

const SUPPORTED_VALUATION_ASSETS = new Set([
  ...Object.keys(UNDERLYING_FOR_PRICE),
  ...Object.keys(ZEST_RECEIPT_VAULTS),
  "USDCx",
  "USDH",
  "USDh",
  "sUSDh",
  "aeUSDC",
  "gUSDC",
  "stSTX",
  "stSTXbtc",
  "stBTC",
  "zvstBTC",
]);

function isSupportedValuationAsset(asset: string): boolean {
  return SUPPORTED_VALUATION_ASSETS.has(asset);
}

function withUnsupportedValuation(position: Position, asset: string): Position {
  return {
    ...position,
    confidence: {
      ...position.confidence,
      state: "unsupported",
      score: Math.min(position.confidence.score, 0.25),
      reasons: [
        ...position.confidence.reasons,
        `USD valuation is unsupported for ${asset}; the raw balance is shown but excluded from monetary totals`,
      ],
    },
  };
}

export async function enrichPositionsWithUsd(
  positions: Position[],
  book: PriceBook,
): Promise<{ positions: Position[]; warnings: string[]; quotes: PriceQuote[] }> {
  // Every leg in one portfolio analysis is judged at the same instant. Without
  // this pin, a quote close to the freshness boundary could value an early row
  // and be rejected for a later row solely because protocol reads took time.
  const valuationStartedAt = Date.now();
  const warnings: string[] = [];
  const quotes: PriceQuote[] = [];
  const quoteCache = new Map<string, PriceQuote | null>();
  function integrityIssue(quote: PriceQuote): string | null {
    if (quote.source === "fixture") return "fixture prices are forbidden outside fixture analysis";
    let price: bigint;
    try {
      price = decimalToScaled(quote.priceUsd, PRICE_SCALE);
    } catch {
      return "price is not a valid fixed-point decimal";
    }
    if (price <= 0n) return "price is not positive";
    const observed = Date.parse(quote.observedAt);
    if (!Number.isFinite(observed)) return "observation time is invalid";
    if (observed > valuationStartedAt + 60_000) return "observation time is in the future";
    const observedAgeSeconds = Math.max(0, Math.floor((valuationStartedAt - observed) / 1_000));
    const effectiveAgeSeconds = Math.max(observedAgeSeconds, quote.ageSeconds ?? 0);
    if (effectiveAgeSeconds > 900) return `quote is stale (${effectiveAgeSeconds}s old)`;
    if (quote.confidence < 0.7)
      return `source confidence ${quote.confidence.toFixed(2)} is below the 0.70 valuation floor`;
    return null;
  }
  async function cachedQuote(asset: string) {
    if (!quoteCache.has(asset)) {
      try {
        const quote = await book.quote(asset);
        const issue = quote ? integrityIssue(quote) : null;
        if (quote && issue) {
          warnings.push(`Rejected USD quote for ${asset}: ${issue}`);
          quoteCache.set(asset, null);
        } else {
          quoteCache.set(asset, quote);
        }
      } catch (error) {
        warnings.push(
          `Price book degraded for ${asset}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
        quoteCache.set(asset, null);
      }
    }
    const quote = quoteCache.get(asset) ?? null;
    if (quote && !quotes.some((item) => item.asset === quote.asset && item.source === quote.source))
      quotes.push(quote);
    return quote;
  }

  const assetsToWarm = new Set<string>();
  for (const position of positions) {
    if (position.type === "wallet" || position.type === "supply") {
      assetsToWarm.add(position.asset.asset);
    } else if (position.type === "lending") {
      const legs = position.legs ?? { collateral: [position.collateral], debt: [position.debt] };
      for (const leg of [...legs.collateral, ...legs.debt]) assetsToWarm.add(leg.asset);
    } else {
      assetsToWarm.add(position.token0.asset);
      assetsToWarm.add(position.token1.asset);
    }
  }
  await mapWithConcurrency([...assetsToWarm], 4, async (asset) => {
    await cachedQuote(asset);
  });

  const enriched: Position[] = [];
  for (const position of positions) {
    if (position.type === "wallet" || position.type === "supply") {
      const quote = await cachedQuote(position.asset.asset);
      if (!quote) {
        const unsupported = !isSupportedValuationAsset(position.asset.asset);
        warnings.push(unsupported
          ? `Unsupported wallet asset ${position.asset.asset}; raw balance shown and excluded from monetary totals`
          : `No USD quote for ${position.type === "wallet" ? "wallet asset" : "supplied asset"} ${position.asset.asset}`);
        enriched.push(
          unsupported
            ? withUnsupportedValuation(position, position.asset.asset)
            : withValuationUnavailable(
                position,
                `USD valuation unavailable for ${position.asset.asset}; monetary totals are withheld`,
              ),
        );
        continue;
      }
      if (quote.source === "fixture") {
        warnings.push(
          `Refusing fixture USD quote for ${position.type === "wallet" ? "wallet asset" : "supplied asset"} ${position.asset.asset}`,
        );
        enriched.push(
          withValuationUnavailable(
            position,
            `Fixture valuation rejected for ${position.asset.asset}; monetary totals are withheld`,
          ),
        );
        continue;
      }
      enriched.push(
        withValue(
          position,
          "asset",
          atomicAmountToUsd(position.asset.amountAtomic, position.asset.decimals, quote.priceUsd),
          quote,
        ),
      );
      continue;
    }
    if (position.type === "lending") {
      const legs = position.legs ?? { collateral: [position.collateral], debt: [position.debt] };
      const collateralLegs = [];
      const debtLegs = [];
      const unsupportedLegs = new Set<string>();
      for (const leg of legs.collateral) {
        const quote = await cachedQuote(leg.asset);
        if (!quote) {
          if (!isSupportedValuationAsset(leg.asset)) unsupportedLegs.add(leg.asset);
          warnings.push(!isSupportedValuationAsset(leg.asset)
            ? `Unsupported collateral asset ${leg.asset}; excluded from monetary risk outputs`
            : `No USD quote for collateral ${leg.asset}`);
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
          valuation: {
            priceUsd: quote.priceUsd,
            source: quote.source,
            observedAt: quote.observedAt,
            ageSeconds: quote.ageSeconds,
            confidence: quote.confidence,
            meaning: quote.meaning,
          },
        });
      }
      for (const leg of legs.debt) {
        const quote = await cachedQuote(leg.asset);
        if (!quote) {
          if (!isSupportedValuationAsset(leg.asset)) unsupportedLegs.add(leg.asset);
          warnings.push(!isSupportedValuationAsset(leg.asset)
            ? `Unsupported debt asset ${leg.asset}; excluded from monetary risk outputs`
            : `No USD quote for debt ${leg.asset}`);
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
          valuation: {
            priceUsd: quote.priceUsd,
            source: quote.source,
            observedAt: quote.observedAt,
            ageSeconds: quote.ageSeconds,
            confidence: quote.confidence,
            meaning: quote.meaning,
          },
        });
      }
      const reason = collateralLegs[0]?.valueUsd
        ? `Valued ${collateralLegs.length} collateral / ${debtLegs.length} debt leg(s) via live price book.`
        : "Multi-asset lending legs partially unpriced.";
      const missingValuation = [...collateralLegs, ...debtLegs].some((leg) => leg.valueUsd === null);
      let next: typeof position = {
        ...position,
        // `collateral` and `debt` are the primary executable legs. Keep their
        // own valuations attached; aggregate portfolio/risk values are derived
        // from `legs`. Assigning the basket total to the primary leg makes its
        // quantity and USD value contradict each other.
        collateral: collateralLegs[0]!,
        debt: debtLegs[0]!,
        legs: { collateral: collateralLegs, debt: debtLegs },
        confidence: {
          ...position.confidence,
          state: unsupportedLegs.size > 0
            ? "unsupported"
            : missingValuation
              ? "degraded"
            : [...collateralLegs, ...debtLegs].some(
                  (leg) => leg.valuation && leg.valuation.confidence < 0.8,
                )
              ? "estimated"
              : position.confidence.state,
          score: Math.min(
            position.confidence.score,
            ...(missingValuation ? [0.5] : []),
            ...[...collateralLegs, ...debtLegs]
              .map((leg) => leg.valuation?.confidence)
              .filter((value): value is number => value !== undefined),
          ),
          reasons: [
            ...position.confidence.reasons,
            ...(position.confidence.reasons.includes(reason) ? [] : [reason]),
            ...(missingValuation
              ? ["At least one collateral or debt leg lacks an acceptable USD quote; monetary risk outputs are withheld"]
              : []),
            ...(unsupportedLegs.size > 0
              ? [`Unsupported lending asset(s): ${[...unsupportedLegs].join(", ")}; raw quantities remain visible`]
              : []),
          ],
        },
      };
      enriched.push(next);
      continue;
    }
    const token0Quote = await cachedQuote(position.token0.asset);
    const token1Quote = await cachedQuote(position.token1.asset);
    const unsupportedLiquidityAssets = [position.token0.asset, position.token1.asset].filter(
      (asset, index) => (index === 0 ? !token0Quote : !token1Quote) && !isSupportedValuationAsset(asset),
    );
    let next = position;
    if (token0Quote && token0Quote.source !== "fixture") {
      next = withValue(
        next,
        "token0",
        atomicAmountToUsd(position.token0.amountAtomic, position.token0.decimals, token0Quote.priceUsd),
        token0Quote,
      ) as typeof position;
    } else
      warnings.push(
        token0Quote?.source === "fixture"
          ? `Refusing fixture USD quote for LP token ${position.token0.asset}`
          : `No USD quote for LP token ${position.token0.asset}`,
      );
    if (token1Quote && token1Quote.source !== "fixture") {
      next = withValue(
        next,
        "token1",
        atomicAmountToUsd(position.token1.amountAtomic, position.token1.decimals, token1Quote.priceUsd),
        token1Quote,
      ) as typeof position;
    } else
      warnings.push(
        token1Quote?.source === "fixture"
          ? `Refusing fixture USD quote for LP token ${position.token1.asset}`
          : `No USD quote for LP token ${position.token1.asset}`,
      );
    if (!token0Quote || token0Quote.source === "fixture" || !token1Quote || token1Quote.source === "fixture") {
      next = (unsupportedLiquidityAssets.length > 0
        ? withUnsupportedValuation(next, unsupportedLiquidityAssets.join(", "))
        : withValuationUnavailable(
            next,
            "At least one liquidity leg lacks an acceptable USD quote; position value and monetary risk outputs are withheld",
          )) as typeof position;
    }
    enriched.push(next);
  }
  return { positions: enriched, warnings, quotes };
}
