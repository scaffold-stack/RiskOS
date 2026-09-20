import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  BitflowMainnetAdapter,
  DEMO_ADDRESS,
  discoverZestVerifiedAssets,
  FixtureBitflowAdapter,
  FixtureWalletAdapter,
  FixtureZestAdapter,
  GraniteMainnetAdapter,
  MainnetYieldMarketCatalog,
  applyYieldMarketRatesToPositions,
  mapWithConcurrency,
  StacksApiAdapter,
  StacksReadOnlyClient,
  ZestMainnetAdapter,
  type YieldMarket,
  type YieldMarketProvider,
} from "../../../packages/adapters/src/index.js";
import type { Position, PositionEnvelope, ProtocolAdapter } from "../../../packages/domain/src/index.js";
import { stacksAddressSchema } from "../../../packages/domain/src/index.js";
import { evaluateRisks } from "../../../packages/risk-engine/src/index.js";
import { planRepay, planZestMainnetRepay } from "../../../packages/execution/src/index.js";
import { walletRequestForIntent } from "../../../packages/execution/src/index.js";
import {
  BitcoinEsploraClient,
  parseChainhookPayload,
  reconcileSbtcAddress,
  SbtcEmilyClient,
  verifySignedRegistry,
  type ContractRegistryVerifier,
  type DataFoundationStore,
  type RegistryStore,
  type StacksBlockReconciler,
} from "../../../packages/data-foundation/src/index.js";
import { timingSafeEqual } from "node:crypto";
import {
  expiredSessionCookie,
  sessionCookie,
  sessionTokenFromHeaders,
  WalletAuthService,
} from "../../../packages/auth/src/index.js";
import {
  createAlertRule,
  MemoryProductStore,
  occurrencesForRule,
  type ProductStore,
} from "../../../packages/workflows/src/index.js";
import { analyzePortfolio } from "../../../packages/portfolio-engine/src/index.js";
import {
  BitflowMarketPriceBook,
  BitflowStablecoinMarketPriceBook,
  CoinbaseExchangePriceBook,
  CoinGeckoPriceBook,
  DiaOraclePriceBook,
  enrichPositionsWithUsd,
  GraniteExchangeRatePriceBook,
  HermeticaExchangeRatePriceBook,
  PythHermesPriceBook,
  QuorumPriceBook,
  ProtocolStablecoinConsensusPriceBook,
  StackingDaoExchangeRatePriceBook,
  ZestVaultExchangeRatePriceBook,
  type PriceBook,
} from "../../../packages/pricing/src/index.js";
import {
  allocateYieldCapital,
  MAX_YIELD_EVIDENCE_AGE_SECONDS,
  MAX_YIELD_SIMULATION_USD,
} from "../../../packages/strategy-engine/src/index.js";

export interface AppOptions {
  dataMode?: "fixture" | "live";
  stacksApiUrl?: string;
  stacksReferenceApiUrl?: string;
  stacksReferenceApiKey?: string;
  now?: () => Date;
  logger?: boolean;
  dataFoundation?: DataFoundationStore;
  chainhookBearerToken?: string;
  network?: "mainnet" | "testnet";
  operationsBearerToken?: string;
  reconciler?: StacksBlockReconciler;
  hiroApiKey?: string;
  registryStore?: RegistryStore;
  trustedRegistryKeyFingerprints?: ReadonlySet<string>;
  bitflowAppApiUrl?: string;
  bitflowQuotesApiUrl?: string;
  hermeticaApiUrl?: string;
  defiLlamaYieldsApiUrl?: string;
  registryVerifier?: ContractRegistryVerifier;
  sbtcEmilyUrl?: string;
  bitcoinEsploraUrl?: string;
  productStore?: ProductStore;
  authAudience?: string;
  priceBook?: PriceBook;
  pythHermesUrl?: string;
  pythHermesToken?: string;
  coinGeckoApiUrl?: string;
  coinGeckoDemoApiKey?: string;
  coinbaseExchangeApiUrl?: string;
  priceMaximumDivergenceBps?: number;
  registryMode?: "signed" | "candidate" | "none";
  adapters?: ProtocolAdapter[];
  yieldMarketProvider?: YieldMarketProvider;
}

const actionPlanSchema = z.object({
  address: stacksAddressSchema,
  positionId: z.string().min(1),
  action: z.literal("repay"),
  amountAtomic: z.string().regex(/^\d+$/),
});

const walletChallengeSchema = z.object({ address: stacksAddressSchema });
const walletVerifySchema = z.object({
  challengeId: z.string().min(1),
  address: stacksAddressSchema,
  publicKey: z.string().min(1),
  signature: z.string().min(1),
});
const alertRuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  categories: z.array(z.enum(["liquidation", "liquidity", "oracle", "bridge", "unsupported"])).min(1),
  minimumSeverity: z.enum(["info", "low", "medium", "high", "critical"]),
});
const submissionSchema = z.object({ txid: z.string().regex(/^0x[a-fA-F0-9]{64}$/) });
const yieldAllocationSchema = z.object({
  capitalUsd: z
    .string()
    .max(16)
    .regex(/^\d+(?:\.\d{0,2})?$/, "Use a positive USD amount with at most two decimal places")
    .refine((value) => usdCents(value) > 0n, "Capital must be greater than zero")
    .refine(
      (value) => usdCents(value) <= MAX_YIELD_SIMULATION_USD * 100n,
      `Capital must not exceed $${MAX_YIELD_SIMULATION_USD.toString()}`,
    ),
  days: z.union([z.literal(30), z.literal(90), z.literal(365)]),
  mode: z.enum(["explore", "recommend"]).default("explore"),
});

function usdCents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function problem(status: number, code: string, title: string, detail: string) {
  return {
    type: `https://docs.riskos.local/errors/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    detail,
  };
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const now = options.now ?? (() => new Date());
  const dataMode = options.dataMode ?? "fixture";
  const network = options.network ?? "mainnet";
  const productStore = options.productStore ?? new MemoryProductStore();
  const auth = new WalletAuthService(
    productStore,
    network,
    options.authAudience ?? process.env.WEB_ORIGIN?.split(",")[0] ?? "http://localhost:5173",
    dataMode === "fixture" && process.env.NODE_ENV !== "production",
  );
  const activeManifest = async () => (await options.registryStore?.active(network))?.manifest ?? null;
  const emily = new SbtcEmilyClient(options.sbtcEmilyUrl ?? "https://sbtc-emily.com");
  const bitcoin = options.bitcoinEsploraUrl ? new BitcoinEsploraClient(options.bitcoinEsploraUrl) : null;
  const stacksClient = new StacksReadOnlyClient(
    options.stacksApiUrl ?? "https://api.mainnet.hiro.so",
    fetch,
    options.hiroApiKey,
  );
  const referenceStacksClient = options.stacksReferenceApiUrl
    ? new StacksReadOnlyClient(options.stacksReferenceApiUrl, fetch, options.stacksReferenceApiKey)
    : undefined;
  // Price reads use the separately operated provider when available. This
  // prevents a primary-indexer 429 from suppressing both position discovery
  // and the on-chain DIA/wrapper-rate leg of the price quorum.
  const pricingStacksClient = referenceStacksClient ?? stacksClient;
  const diaPriceBook = new DiaOraclePriceBook(pricingStacksClient, undefined, 900, now);
  const coinGeckoPriceBook = new CoinGeckoPriceBook(
    options.coinGeckoApiUrl,
    options.coinGeckoDemoApiKey,
    // Match the product's 300-second evidence budget. CoinGecko's free feed
    // can legitimately publish less often than every two minutes; treating a
    // 121-second observation as unusable caused otherwise agreeing DIA prices
    // to lose quorum and cascaded into sBTC/USDCx/receipt-token failures.
    300,
    fetch,
    now,
  );
  const coinbasePriceBook = new CoinbaseExchangePriceBook(options.coinbaseExchangeApiUrl, 120, fetch, now);
  const marketSources: PriceBook[] = [diaPriceBook, coinGeckoPriceBook, coinbasePriceBook];
  if (options.pythHermesToken) {
    marketSources.push(
      new PythHermesPriceBook(options.pythHermesToken, options.pythHermesUrl, 60, fetch, now),
    );
  }
  const consensusPriceBook: PriceBook = new QuorumPriceBook(
    marketSources,
    2,
    options.priceMaximumDivergenceBps ?? 150,
    0.7,
    now,
  );
  const marketPriceBook = new BitflowMarketPriceBook(
    consensusPriceBook,
    activeManifest,
    options.bitflowAppApiUrl ?? "https://bff.bitflowapis.finance/api/app",
    options.bitflowQuotesApiUrl ?? "https://bff.bitflowapis.finance/api/quotes",
    500,
    fetch,
    now,
  );
  const stablecoinMarketPriceBook = new BitflowStablecoinMarketPriceBook(
    marketPriceBook,
    activeManifest,
    options.bitflowQuotesApiUrl ?? "https://bff.bitflowapis.finance/api/quotes",
    fetch,
    now,
  );
  const protocolStablecoinPriceBook = new ProtocolStablecoinConsensusPriceBook(
    marketPriceBook,
    stablecoinMarketPriceBook,
    diaPriceBook,
    coinbasePriceBook,
  );
  const priceBook =
    options.priceBook ??
    (dataMode === "live"
      ? new ZestVaultExchangeRatePriceBook(
          new HermeticaExchangeRatePriceBook(
            new GraniteExchangeRatePriceBook(
              new StackingDaoExchangeRatePriceBook(
                protocolStablecoinPriceBook,
                pricingStacksClient,
                activeManifest,
                now,
              ),
              pricingStacksClient,
              activeManifest,
              now,
            ),
            pricingStacksClient,
            activeManifest,
            now,
          ),
          pricingStacksClient,
          activeManifest,
          now,
        )
      : undefined);
  let verifiedAssetCache: {
    version: string;
    expiresAt: number;
    assets: Awaited<ReturnType<typeof discoverZestVerifiedAssets>>;
  } | null = null;
  let verifiedAssetLoad: Promise<Awaited<ReturnType<typeof discoverZestVerifiedAssets>>> | null = null;
  const verifiedAssets = async (walletAssetIdentifiers: readonly string[] = []) => {
    const manifest = await activeManifest();
    if (!manifest) return [];
    const staticAssets = manifest.entries
      .filter((entry) => entry.enabled)
      .flatMap((entry) =>
        entry.assetDefinitions.map((asset) =>
          (entry.protocol === "zest-v2" && asset.symbol.startsWith("z")) ||
          (entry.protocol === "hermetica" && asset.symbol === "sUSDh") ||
          (entry.protocol === "granite" && asset.symbol === "gUSDC")
            ? {
                ...asset,
                positionType: "supply" as const,
                protocol: {
                  id: entry.protocol === "zest-v2" ? "zest" : entry.protocol,
                  version: entry.adapterVersion,
                  contract: asset.assetIdentifier.slice(0, asset.assetIdentifier.lastIndexOf("::")),
                },
              }
            : asset,
        ),
      );
    const staticIdentifiers = new Set(staticAssets.map((asset) => asset.assetIdentifier));
    const zestContracts = new Set(
      manifest.entries
        .filter((entry) => entry.enabled && entry.protocol === "zest-v2")
        .map((entry) => entry.contractPrincipal),
    );
    const unresolvedWalletZestAsset = walletAssetIdentifiers.some((assetIdentifier) => {
      if (staticIdentifiers.has(assetIdentifier)) return false;
      const separator = assetIdentifier.lastIndexOf("::");
      return separator > 0 && zestContracts.has(assetIdentifier.slice(0, separator));
    });
    // A complete signed manifest is the fastest and strongest identity source.
    // Only scan Zest's on-chain asset registry when this wallet actually holds
    // a registered vault receipt whose SIP-010 identity is absent from it.
    if (!unresolvedWalletZestAsset) return staticAssets;
    if (verifiedAssetCache?.version === manifest.version && verifiedAssetCache.expiresAt > now().getTime()) {
      return [...staticAssets, ...verifiedAssetCache.assets];
    }
    try {
      verifiedAssetLoad ??= discoverZestVerifiedAssets(activeManifest, pricingStacksClient);
      const assets = await verifiedAssetLoad;
      verifiedAssetCache = { version: manifest.version, expiresAt: now().getTime() + 60_000, assets };
      return [...staticAssets, ...assets];
    } catch {
      // Unknown tokens remain unsupported and unvalued if the pinned asset-registry
      // read is unavailable. The wallet adapter must not guess token identities.
      return staticAssets;
    } finally {
      verifiedAssetLoad = null;
    }
  };
  const excludedWalletAssets = async () => {
    const manifest = await activeManifest();
    const bitflowReceipts =
      manifest?.entries
        .filter((entry) => entry.enabled && entry.protocol === "bitflow")
        .map((entry) => `${entry.contractPrincipal}::pool-token`) ?? [];
    // Bitflow ownership receipts are expanded into their underlying pool legs
    // by the Bitflow adapter. Zest receipts held in the wallet are different:
    // they are liquid supply claims and must remain visible in addition to any
    // separate collateral recorded inside a Zest lending account.
    return [...new Set(bitflowReceipts)];
  };
  const adapters: ProtocolAdapter[] =
    options.adapters ??
    (dataMode === "fixture"
      ? [new FixtureZestAdapter(), new FixtureBitflowAdapter(), new FixtureWalletAdapter()]
      : [
          new StacksApiAdapter(
            options.stacksApiUrl ?? "https://api.mainnet.hiro.so",
            fetch,
            options.hiroApiKey,
            verifiedAssets,
            excludedWalletAssets,
            referenceStacksClient,
          ),
          new ZestMainnetAdapter(activeManifest, pricingStacksClient),
          new GraniteMainnetAdapter(activeManifest, pricingStacksClient),
          new BitflowMainnetAdapter(
            activeManifest,
            options.bitflowAppApiUrl ?? "https://bff.bitflowapis.finance/api/app",
            options.bitflowQuotesApiUrl ?? "https://bff.bitflowapis.finance/api/quotes",
            fetch,
            options.stacksApiUrl ?? "https://api.mainnet.hiro.so",
            options.hiroApiKey,
            referenceStacksClient,
          ),
        ]);
  const fixtureYieldMarkets: YieldMarket[] = [
    {
      id: "fixture:zest:sbtc",
      protocol: "zest",
      kind: "lending",
      assets: "sBTC",
      annualizedRateBps: 625,
      rateLabel: "Supply APR",
      evidenceState: "verified",
      confidenceScore: 0.92,
      observedAtBlock: 123_456,
      observedAt: now().toISOString(),
      tvlUsd: "50000000",
      independentRateEvidence: { source: "fixture-reference", observedAt: now().toISOString(), annualizedRateBps: 625, differenceBps: 0 },
      capacityEvidence: { source: "fixture-capacity", observedAt: now().toISOString(), tvlUsd: "50000000" },
      source: "fixture-zest-vault",
      meaning: "Fixture pinned-vault rate evidence.",
      eligibleForAllocation: true,
    },
    {
      id: "fixture:bitflow:sbtc-usdcx",
      protocol: "bitflow",
      kind: "liquidity",
      assets: "sBTC / USDCx",
      annualizedRateBps: 800,
      rateLabel: "Fee APR",
      evidenceState: "verified",
      confidenceScore: 0.9,
      observedAtBlock: 123_456,
      observedAt: now().toISOString(),
      tvlUsd: "50000000",
      independentRateEvidence: { source: "fixture-reference", observedAt: now().toISOString(), annualizedRateBps: 800, differenceBps: 0 },
      capacityEvidence: { source: "fixture-capacity", observedAt: now().toISOString(), tvlUsd: "50000000" },
      source: "fixture-bitflow-canonical-fees",
      meaning: "Fixture rate reconstructed from canonical pool fee evidence.",
      eligibleForAllocation: true,
    },
  ];
  const yieldMarketProvider: YieldMarketProvider =
    options.yieldMarketProvider ??
    (dataMode === "fixture"
      ? async () => fixtureYieldMarkets
      : () =>
          new MainnetYieldMarketCatalog(
            activeManifest,
            pricingStacksClient,
            options.bitflowAppApiUrl ?? "https://bff.bitflowapis.finance/api/app",
            fetch,
            now,
            options.hermeticaApiUrl ?? "https://app.hermetica.fi",
            options.defiLlamaYieldsApiUrl ?? "https://yields.llama.fi/pools",
          ).discover());
  let yieldMarketCache: { expiresAt: number; markets: YieldMarket[] } | null = null;
  let yieldMarketLoad: Promise<YieldMarket[]> | null = null;
  async function currentYieldMarkets() {
    if (yieldMarketCache && yieldMarketCache.expiresAt > now().getTime()) return yieldMarketCache.markets;
    yieldMarketLoad ??= yieldMarketProvider();
    try {
      const markets = await yieldMarketLoad;
      const loadedAt = now().getTime();
      const zestMarkets = markets.filter((market) => market.protocol === "zest");
      const zestRatesAvailable = zestMarkets.some((market) => market.annualizedRateBps !== null);
      const zestTransientMiss = zestMarkets.some(
        (market) =>
          market.evidenceState === "unavailable" &&
          /429|rate limit|timed out|timeout|ECONNRESET|fetch failed/i.test(market.meaning),
      );
      // Avoid caching a fully rate-limited Zest catalog — or a partial catalog that
      // still has vaults missing from provider 429s — for minutes.
      if ((zestMarkets.length > 0 && !zestRatesAvailable) || zestTransientMiss) {
        return markets;
      }
      const allocatableObservations = markets
        .filter((market) => market.eligibleForAllocation)
        .map((market) => Date.parse(market.observedAt))
        .filter(Number.isFinite);
      const evidenceExpiry = allocatableObservations.length === 0
        ? loadedAt + 240_000
        : Math.min(...allocatableObservations) + MAX_YIELD_EVIDENCE_AGE_SECONDS * 1_000;
      yieldMarketCache = { expiresAt: Math.min(loadedAt + 240_000, evidenceExpiry), markets };
      return markets;
    } finally {
      yieldMarketLoad = null;
    }
  }

  async function ensureCanonicalSnapshotBlock(
    height: number,
    manifest: NonNullable<Awaited<ReturnType<typeof activeManifest>>>,
  ) {
    if (!options.dataFoundation) return null;
    const existing = await options.dataFoundation.canonicalBlock(network, height);
    if (existing) return existing;
    const baseUrl = (options.stacksApiUrl ?? "https://api.mainnet.hiro.so").replace(/\/$/, "");
    const headers = {
      accept: "application/json",
      "user-agent": "riskos/0.1-snapshot-sync",
      ...(options.hiroApiKey ? { "x-api-key": options.hiroApiKey } : {}),
    };
    const [blockResponse, transactionsResponse] = await Promise.all([
      fetch(`${baseUrl}/extended/v2/blocks/${height}`, { headers, signal: AbortSignal.timeout(20_000) }),
      fetch(`${baseUrl}/extended/v1/tx/block_height/${height}?limit=50`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      }),
    ]);
    if (!blockResponse.ok || !transactionsResponse.ok) {
      throw new Error(`Canonical snapshot block synchronization failed at ${height}`);
    }
    const block = (await blockResponse.json()) as Record<string, unknown>;
    const transactions = (await transactionsResponse.json()) as { results?: unknown[] };
    if (
      block.canonical !== true ||
      Number(block.height) !== height ||
      typeof block.index_block_hash !== "string"
    ) {
      throw new Error(`Stacks provider did not return a canonical block at ${height}`);
    }
    const payload = {
      chainhook: { uuid: `snapshot-sync-${network}-${height}` },
      rollback: [],
      apply: [
        {
          block_identifier: { index: height, hash: String(block.hash) },
          parent_block_identifier: {
            index: Math.max(0, height - 1),
            hash: String(block.parent_block_hash ?? block.parent_index_block_hash),
          },
          metadata: {
            index_block_hash: block.index_block_hash,
            burn_block_height: block.burn_block_height,
            block_time: block.block_time,
          },
          transactions: (transactions.results ?? []).map((value, txIndex) => {
            const transaction = value as Record<string, unknown>;
            return {
              transaction_identifier: {
                hash: String(transaction.tx_id ?? transaction.txid ?? `unknown-${height}-${txIndex}`),
              },
              metadata: {
                success:
                  transaction.tx_status === "success" ||
                  transaction.canonical === true ||
                  transaction.success === true,
                receipt: { events: Array.isArray(transaction.events) ? transaction.events : [] },
              },
            };
          }),
        },
      ],
    };
    await options.dataFoundation.ingest(
      parseChainhookPayload(payload, {
        network,
        deliveryId: `snapshot-sync-${network}-${height}-${block.index_block_hash}`,
        source: "hiro-snapshot-sync",
      }),
      manifest,
    );
    return options.dataFoundation.canonicalBlock(network, height);
  }

  async function persistCanonicalSnapshot(
    address: string,
    envelope: PositionEnvelope,
    manifest: NonNullable<Awaited<ReturnType<typeof activeManifest>>>,
  ) {
    if (!options.dataFoundation) throw new Error("Canonical storage is unavailable");
    const evidenceCounts = new Map<number, number>();
    for (const position of envelope.positions) {
      for (const height of new Set(
        position.provenance
          .map((item) => item.blockHeight)
          .filter((value): value is number => value !== undefined),
      )) {
        evidenceCounts.set(height, (evidenceCounts.get(height) ?? 0) + 1);
      }
    }
    const snapshotHeight = [...evidenceCounts.entries()].sort(
      (left, right) => right[1] - left[1] || right[0] - left[0],
    )[0]?.[0];
    if (snapshotHeight === undefined) {
      throw new Error("No position has block-pinned evidence suitable for a canonical snapshot");
    }
    const tip = await ensureCanonicalSnapshotBlock(snapshotHeight, manifest);
    if (!tip) throw new Error(`Canonical block ${snapshotHeight} could not be synchronized`);
    const eligible = envelope.positions.filter((position) =>
      position.provenance.some((item) => item.blockHeight === tip.height),
    );
    const skipped = envelope.positions
      .filter((position) => !eligible.includes(position))
      .map((position) => position.id);
    const persisted = await options.dataFoundation.savePositionSnapshots({
      network,
      address,
      indexBlockHash: tip.indexBlockHash,
      blockHeight: tip.height,
      registryVersion: manifest.version,
      positions: eligible,
    });
    return { tip, persisted, skipped };
  }

  function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
    const supplied = header?.replace(/^Bearer\s+/i, "") ?? "";
    const target = expected ?? "";
    return (
      supplied.length === target.length &&
      supplied.length > 0 &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(target))
    );
  }

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN?.split(",") ?? ["http://localhost:5173"],
    methods: ["GET", "POST"],
    credentials: true,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.get("/v1/yield/markets", async (_request, reply) => {
    try {
      const markets = await currentYieldMarkets();
      return { asOf: now().toISOString(), markets };
    } catch (error) {
      return reply
        .code(502)
        .send(
          problem(
            502,
            "YIELD_MARKETS_UNAVAILABLE",
            "Yield markets unavailable",
            error instanceof Error ? error.message : "Market discovery failed",
          ),
        );
    }
  });

  app.post("/v1/yield/allocations", async (request, reply) => {
    const parsed = yieldAllocationSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_YIELD_INPUT",
            "Invalid simulation input",
            parsed.error.issues[0]?.message ?? "Invalid input",
          ),
        );
    try {
      const markets = await currentYieldMarkets();
      return allocateYieldCapital(parsed.data.capitalUsd, parsed.data.days, markets, now(), parsed.data.mode);
    } catch (error) {
      return reply
        .code(502)
        .send(
          problem(
            502,
            "YIELD_ALLOCATION_UNAVAILABLE",
            "Yield allocation unavailable",
            error instanceof Error ? error.message : "Allocation failed",
          ),
        );
    }
  });

  const positionLoads = new Map<string, Promise<PositionEnvelope>>();
  const positionCache = new Map<string, { envelope: PositionEnvelope; expiresAt: number }>();

  async function discoverPositions(address: string): Promise<PositionEnvelope> {
    // Two adapters at a time; the shared stacksReadGate(2) caps tip/call-read
    // fan-out so Zest and Bitflow no longer stampede Hiro/QuickNode together.
    const settled = await mapWithConcurrency(adapters, 2, async (adapter) => {
      try {
        return { status: "fulfilled" as const, value: await adapter.discover(address), adapter };
      } catch (reason) {
        return { status: "rejected" as const, reason, adapter };
      }
    });
    const positions: Position[] = [];
    const warnings: string[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") positions.push(...result.value);
      else
        warnings.push(
          `${result.adapter.id} adapter degraded: ${result.reason instanceof Error ? result.reason.message : "unknown error"}`,
        );
    }
    let rateEnriched = positions;
    if (dataMode === "live" && positions.some((position) => position.type === "supply" && !position.earnings)) {
      try {
        // Run after adapters so rate reads do not compete with discovery for the
        // same Stacks tip quota. Warm cache keeps subsequent inspects fast.
        const markets = await currentYieldMarkets();
        rateEnriched = applyYieldMarketRatesToPositions(positions, markets);
      } catch (error) {
        warnings.push(
          `Yield-rate enrichment degraded: ${error instanceof Error ? error.message : "market discovery failed"}`,
        );
      }
    }
    let valued = rateEnriched;
    if (priceBook && dataMode === "live") {
      const enriched = await enrichPositionsWithUsd(rateEnriched, priceBook);
      valued = enriched.positions;
      warnings.push(...enriched.warnings);
      if (enriched.quotes.some((quote) => quote.source === "fixture")) {
        warnings.push(
          "Live mode received fixture USD quotes; valuations were left incomplete where DIA was unavailable.",
        );
      }
    }
    const canonicalTip = options.dataFoundation ? await options.dataFoundation.canonicalTip(network) : null;
    // Environment advisories are logged by ops config; keep envelope.warnings for
    // adapter/price failures that affect this address's discovery result.
    if (dataMode === "live" && !(await activeManifest())) {
      warnings.push(
        "No active registry manifest. Zest/Bitflow reads will fail closed until a candidate or signed registry is loaded.",
      );
    }
    const sourceTipHeights = valued
      .flatMap((position) => position.provenance)
      .map((item) => item.blockHeight)
      .filter((height): height is number => typeof height === "number");
    const tipHeight = sourceTipHeights.length > 0 ? Math.max(...sourceTipHeights) : undefined;
    if (dataMode === "live" && !canonicalTip && tipHeight === undefined) {
      warnings.push(
        "Stacks block provenance is unavailable from both Chainhook persistence and pinned source reads",
      );
    }
    const envelope: PositionEnvelope = {
      address,
      asOf: {
        stacksBlockHeight: dataMode === "fixture" ? 123_456 : (canonicalTip?.height ?? tipHeight ?? 0),
        bitcoinBlockHeight: dataMode === "fixture" ? 966_350 : (canonicalTip?.burnBlockHeight ?? 0),
        observedAt: now().toISOString(),
      },
      positions: valued,
      warnings,
    };
    if (dataMode === "live" && options.dataFoundation && canonicalTip) {
      const registry = await options.registryStore?.active(network);
      const allAtCanonicalTip = valued.every((position) =>
        position.provenance.some((item) => item.blockHeight === canonicalTip.height),
      );
      if (registry && valued.length > 0 && allAtCanonicalTip) {
        await options.dataFoundation.savePositionSnapshots({
          network,
          address,
          indexBlockHash: canonicalTip.indexBlockHash,
          blockHeight: canonicalTip.height,
          registryVersion: registry.manifest.version,
          positions: valued,
        });
      }
    }
    return envelope;
  }

  async function positionsFor(address: string): Promise<PositionEnvelope> {
    const cached = positionCache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.envelope;

    const inflight = positionLoads.get(address);
    if (inflight) return inflight;

    // Set the promise in the map synchronously before any await so concurrent
    // overview/risk/portfolio callers share one discovery.
    const load = discoverPositions(address);
    positionLoads.set(address, load);
    try {
      const envelope = await load;
      positionCache.set(address, { envelope, expiresAt: Date.now() + 45_000 });
      return envelope;
    } finally {
      if (positionLoads.get(address) === load) positionLoads.delete(address);
    }
  }

  app.get("/health", async () => ({
    status: "ok",
    dataMode,
    network,
    registryMode: options.registryMode ?? (options.registryStore ? "signed" : "none"),
    execution: dataMode === "fixture" ? "testnet-fixture-only" : "advisory-shadow-only",
    pricing:
      dataMode === "live"
        ? options.pythHermesToken
          ? "2-of-4(dia,pyth,coingecko,coinbase)+bitflow-usdcx+stackingdao-rates+zest-vault"
          : "2-of-3(dia,coingecko,coinbase)+bitflow-usdcx+stackingdao-rates+zest-vault"
        : "fixture-embedded",
    modules: {
      positions: dataMode === "live" ? "mainnet-reads" : "fixtures",
      risk: "deterministic",
      protect: dataMode === "live" ? "advisory-shadow" : "testnet-fixture",
      distribution: "sdk+widget",
    },
    time: now().toISOString(),
  }));

  app.get("/v1/demo", async () => ({ address: DEMO_ADDRESS }));

  app.post("/v1/auth/challenge", async (request, reply) => {
    const parsed = walletChallengeSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ADDRESS",
            "Invalid Stacks address",
            parsed.error.issues[0]?.message ?? "Invalid address",
          ),
        );
    return reply.code(201).send(await auth.challenge(parsed.data.address, now()));
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const parsed = walletVerifySchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_WALLET_PROOF",
            "Invalid wallet proof",
            parsed.error.issues.map((issue) => issue.message).join(", "),
          ),
        );
    try {
      const verified = await auth.verify(parsed.data, now());
      reply.header(
        "set-cookie",
        sessionCookie(verified.token, verified.session.expiresAt, process.env.NODE_ENV === "production"),
      );
      return verified.session;
    } catch (error) {
      return reply
        .code(401)
        .send(
          problem(
            401,
            "WALLET_PROOF_REJECTED",
            "Wallet proof rejected",
            error instanceof Error ? error.message : "Signature verification failed",
          ),
        );
    }
  });

  async function sessionFor(
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  ) {
    const session = await auth.authenticate(sessionTokenFromHeaders(request.headers), now());
    if (!session)
      reply
        .code(401)
        .send(
          problem(
            401,
            "WALLET_SESSION_REQUIRED",
            "Wallet session required",
            "Connect and sign the RiskOS ownership challenge before continuing.",
          ),
        );
    return session;
  }

  app.get("/v1/auth/session", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    return { address: session.address, expiresAt: session.expiresAt };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    await auth.logout(sessionTokenFromHeaders(request.headers));
    reply.header("set-cookie", expiredSessionCookie(process.env.NODE_ENV === "production"));
    return reply.code(204).send();
  });

  app.post("/v1/ingest/chainhooks/stacks", async (request, reply) => {
    if (!options.dataFoundation) {
      return reply
        .code(503)
        .send(
          problem(
            503,
            "INGESTION_UNAVAILABLE",
            "Ingestion unavailable",
            "The canonical event store is not configured.",
          ),
        );
    }
    if (!bearerMatches(request.headers.authorization, options.chainhookBearerToken)) {
      return reply
        .code(401)
        .send(
          problem(
            401,
            "INGESTION_UNAUTHORIZED",
            "Unauthorized",
            "A valid Chainhook bearer token is required.",
          ),
        );
    }
    try {
      const batch = parseChainhookPayload(request.body, {
        network,
        ...(typeof request.headers["x-chainhook-delivery"] === "string"
          ? { deliveryId: request.headers["x-chainhook-delivery"] }
          : {}),
      });
      const result = await options.dataFoundation.ingest(batch, await activeManifest());
      return reply.code(result.duplicate ? 200 : 202).send(result);
    } catch (error) {
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_CHAINHOOK_PAYLOAD",
            "Invalid Chainhook payload",
            error instanceof Error ? error.message : "Payload rejected",
          ),
        );
    }
  });

  app.get("/v1/system/health", async () => ({
    status: options.dataFoundation ? "available" : "degraded",
    sources: options.dataFoundation ? await options.dataFoundation.sourceHealth() : [],
    warnings: options.dataFoundation ? [] : ["Canonical event store is not configured"],
  }));

  app.post<{ Params: { height: string } }>(
    "/v1/operations/reconcile/stacks/:height",
    async (request, reply) => {
      if (!bearerMatches(request.headers.authorization, options.operationsBearerToken)) {
        return reply
          .code(401)
          .send(
            problem(
              401,
              "OPERATIONS_UNAUTHORIZED",
              "Unauthorized",
              "A valid operations bearer token is required.",
            ),
          );
      }
      if (!options.reconciler) {
        return reply
          .code(503)
          .send(
            problem(
              503,
              "RECONCILIATION_UNAVAILABLE",
              "Reconciliation unavailable",
              "The reconciliation service is not configured.",
            ),
          );
      }
      const height = Number(request.params.height);
      if (!Number.isSafeInteger(height) || height < 0) {
        return reply
          .code(400)
          .send(
            problem(
              400,
              "INVALID_BLOCK_HEIGHT",
              "Invalid block height",
              "Height must be a non-negative safe integer.",
            ),
          );
      }
      const result = await options.reconciler.reconcile(network, height);
      return reply.code(result.state === "red" ? 409 : 200).send(result);
    },
  );

  app.post("/v1/operations/registry/activate", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.operationsBearerToken)) {
      return reply
        .code(401)
        .send(
          problem(
            401,
            "OPERATIONS_UNAUTHORIZED",
            "Unauthorized",
            "A valid operations bearer token is required.",
          ),
        );
    }
    if (!options.registryStore || !options.trustedRegistryKeyFingerprints) {
      return reply
        .code(503)
        .send(
          problem(
            503,
            "REGISTRY_UNAVAILABLE",
            "Registry unavailable",
            "The signed registry store is not configured.",
          ),
        );
    }
    try {
      const registry = verifySignedRegistry(request.body, options.trustedRegistryKeyFingerprints, now());
      const verification = options.registryVerifier
        ? await options.registryVerifier.verifyManifest(registry.manifest)
        : [];
      const rejected = verification.filter((result) => !result.valid);
      if (rejected.length > 0) {
        return reply
          .code(400)
          .send(
            problem(
              400,
              "REGISTRY_ONCHAIN_MISMATCH",
              "Registry on-chain verification failed",
              rejected.map((result) => `${result.contractPrincipal}: ${result.errors.join(", ")}`).join("; "),
            ),
          );
      }
      const activation = await options.registryStore.activate(
        request.body,
        options.trustedRegistryKeyFingerprints,
        now(),
      );
      return reply.code(202).send({ ...activation, verification });
    } catch (error) {
      return reply
        .code(400)
        .send(
          problem(
            400,
            "REGISTRY_REJECTED",
            "Registry rejected",
            error instanceof Error ? error.message : "Registry activation failed",
          ),
        );
    }
  });

  app.get<{ Params: { address: string } }>("/v1/address/:address/positions", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ADDRESS",
            "Invalid Stacks address",
            parsed.error.issues[0]?.message ?? "Invalid address",
          ),
        );
    return positionsFor(parsed.data);
  });

  app.get<{ Params: { address: string }; Querystring: { limit?: string } }>(
    "/v1/address/:address/history",
    async (request, reply) => {
      const parsed = stacksAddressSchema.safeParse(request.params.address);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            problem(
              400,
              "INVALID_ADDRESS",
              "Invalid Stacks address",
              parsed.error.issues[0]?.message ?? "Invalid address",
            ),
          );
      }
      if (!options.dataFoundation) {
        return reply
          .code(503)
          .send(
            problem(
              503,
              "HISTORY_UNAVAILABLE",
              "Canonical history unavailable",
              "A canonical event and snapshot store is required; RiskOS will not synthesize historical values.",
            ),
          );
      }
      const requestedLimit = Number(request.query.limit ?? 100);
      const observationLimit = Number.isSafeInteger(requestedLimit)
        ? Math.min(1_000, Math.max(1, requestedLimit))
        : 100;
      const cashFlowKinds = ["vault-deposit", "vault-redeem", "pool-mint", "pool-burn"] as const;
      const [snapshots, cashFlowEvents] = await Promise.all([
        options.dataFoundation.positionSnapshotHistory(network, parsed.data, observationLimit),
        options.dataFoundation.cashFlowEventsForAddress(network, parsed.data, cashFlowKinds, 500),
      ]);
      const grouped = new Map<
        string,
        {
          indexBlockHash: string;
          blockHeight: number;
          observedAt: string;
          registryVersion: string;
          positions: Position[];
        }
      >();
      for (const snapshot of snapshots) {
        const key = `${snapshot.blockHeight}:${snapshot.indexBlockHash}`;
        const observedAt =
          snapshot.position.provenance
            .map((item) => item.observedAt)
            .sort()
            .at(-1) ?? new Date(0).toISOString();
        const existing = grouped.get(key);
        if (existing) existing.positions.push(snapshot.position);
        else {
          grouped.set(key, {
            indexBlockHash: snapshot.indexBlockHash,
            blockHeight: snapshot.blockHeight,
            observedAt,
            registryVersion: snapshot.registryVersion,
            positions: [snapshot.position],
          });
        }
      }
      const observations = [...grouped.values()]
        .sort((a, b) => a.blockHeight - b.blockHeight)
        .map((observation) => {
          const historicalSummary = analyzePortfolio(
            {
              address: parsed.data,
              asOf: {
                stacksBlockHeight: observation.blockHeight,
                bitcoinBlockHeight: 0,
                observedAt: observation.observedAt,
              },
              positions: observation.positions,
              warnings: [],
            },
            [],
            { allowFixtureEvidence: dataMode === "fixture" },
          );
          return {
            indexBlockHash: observation.indexBlockHash,
            blockHeight: observation.blockHeight,
            observedAt: observation.observedAt,
            registryVersion: observation.registryVersion,
            // Chart/history consumers only need the valued aggregates. Omitting
            // full position payloads keeps this endpoint responsive.
            positions: [] as Position[],
            valuedNetSubtotalUsd: historicalSummary.valuedSubtotalUsd,
            valuedAssetsSubtotalUsd: historicalSummary.valuedAssetsSubtotalUsd,
            valuedDebtSubtotalUsd: historicalSummary.valuedDebtSubtotalUsd,
            valuedPositionCount: historicalSummary.valuedPositionCount,
            excludedPositionCount: historicalSummary.missingValuationCount,
            complete: historicalSummary.netWorthUsd !== null,
          };
        });
      const cashFlows = cashFlowEvents.map((event) => ({
        protocol: event.protocol as "zest" | "bitflow",
        kind: event.kind,
        blockHeight: event.blockHeight,
        indexBlockHash: event.indexBlockHash,
        transactionId: event.txId,
        positionKey: event.positionKey,
        amounts: event.payload,
      }));
      return {
        address: parsed.data,
        observations,
        cashFlows,
        integrity: {
          canonicalOnly: true,
          reorgInvalidatedSnapshotsExcluded: true,
          state:
            observations.length >= 2
              ? "observations-available"
              : observations.length === 1
                ? "baseline-only"
                : "no-baseline",
        },
        earnedYield: {
          valueUsd: null,
          state: cashFlows.length > 0 ? "attribution-required" : "cash-flow-history-required",
          meaning:
            cashFlows.length > 0
              ? `${cashFlows.length} canonical protocol cash flow${cashFlows.length === 1 ? " is" : "s are"} available. Price effect, fee/incentive events, and opening share basis must still reconcile before earned yield is shown.`
              : "No canonical protocol cash flows are stored for this address. Deposits, withdrawals, fees, incentives, and price movement must be reconciled before an earned amount is shown.",
        },
      };
    },
  );

  app.post<{ Params: { address: string } }>("/v1/operations/snapshots/:address", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.operationsBearerToken)) {
      return reply
        .code(401)
        .send(
          problem(
            401,
            "OPERATIONS_UNAUTHORIZED",
            "Unauthorized",
            "A valid operations bearer token is required.",
          ),
        );
    }
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ADDRESS",
            "Invalid Stacks address",
            parsed.error.issues[0]?.message ?? "Invalid address",
          ),
        );
    if (!options.dataFoundation || !options.registryStore) {
      return reply
        .code(503)
        .send(
          problem(
            503,
            "SNAPSHOTS_UNAVAILABLE",
            "Snapshots unavailable",
            "Canonical storage and the active registry are required.",
          ),
        );
    }
    const [registry, envelope] = await Promise.all([
      options.registryStore.active(network),
      positionsFor(parsed.data),
    ]);
    if (!registry)
      return reply
        .code(409)
        .send(
          problem(
            409,
            "CANONICAL_CONTEXT_UNAVAILABLE",
            "Canonical context unavailable",
            "An active registry is required.",
          ),
        );
    let snapshot: Awaited<ReturnType<typeof persistCanonicalSnapshot>>;
    try {
      snapshot = await persistCanonicalSnapshot(parsed.data, envelope, registry.manifest);
    } catch (error) {
      return reply
        .code(409)
        .send(
          problem(
            409,
            "CANONICAL_CONTEXT_UNAVAILABLE",
            "Canonical context unavailable",
            error instanceof Error ? error.message : "Canonical snapshot persistence failed.",
          ),
        );
    }
    return reply.code(202).send({
      indexBlockHash: snapshot.tip.indexBlockHash,
      blockHeight: snapshot.tip.height,
      persisted: snapshot.persisted,
      skipped: snapshot.skipped,
      warning: snapshot.skipped.length
        ? "Positions without provenance at the canonical tip were not snapshotted"
        : null,
    });
  });

  app.get<{ Params: { address: string } }>("/v1/address/:address/sbtc-operations", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ADDRESS",
            "Invalid Stacks address",
            parsed.error.issues[0]?.message ?? "Invalid address",
          ),
        );
    if (!options.dataFoundation || !bitcoin) {
      return reply
        .code(503)
        .send(
          problem(
            503,
            "SBTC_RECONCILIATION_UNAVAILABLE",
            "sBTC reconciliation unavailable",
            "Canonical event storage and a Bitcoin Esplora provider are required.",
          ),
        );
    }
    try {
      const events = await options.dataFoundation.protocolEventsForAddress(network, "sbtc", parsed.data);
      return {
        address: parsed.data,
        operations: await reconcileSbtcAddress(parsed.data, events, emily, bitcoin),
      };
    } catch (error) {
      return reply
        .code(502)
        .send(
          problem(
            502,
            "SBTC_EVIDENCE_UNAVAILABLE",
            "sBTC evidence unavailable",
            error instanceof Error ? error.message : "An evidence source failed",
          ),
        );
    }
  });

  async function portfolioFor(address: string, envelope: PositionEnvelope) {
    if (dataMode === "live" && options.dataFoundation && options.registryStore) {
      try {
        const registry = await options.registryStore.active(network);
        if (registry) await persistCanonicalSnapshot(address, envelope, registry.manifest);
      } catch {
        // Portfolio analysis remains available when the optional history recorder is degraded.
      }
    }
    let btcReferencePriceUsd: string | null = null;
    if (priceBook && dataMode === "live") {
      try {
        const quote = (await priceBook.quote("BTC")) ?? (await priceBook.quote("sBTC"));
        if (quote && quote.source !== "fixture") btcReferencePriceUsd = quote.priceUsd;
      } catch {
        btcReferencePriceUsd = null;
      }
    }
    const risks = evaluateRisks(envelope.positions, now());
    return {
      risks,
      portfolio: analyzePortfolio(envelope, risks, {
        btcReferencePriceUsd,
        allowFixtureEvidence: dataMode === "fixture",
      }),
    };
  }

  app.get<{ Params: { address: string } }>("/v1/address/:address/risk", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ADDRESS",
            "Invalid Stacks address",
            parsed.error.issues[0]?.message ?? "Invalid address",
          ),
        );
    const envelope = await positionsFor(parsed.data);
    const risks = evaluateRisks(envelope.positions, now());
    const rules = await productStore.alertRules(parsed.data);
    for (const rule of rules) await productStore.putOccurrences(occurrencesForRule(rule, risks, now()));
    return {
      address: parsed.data,
      asOf: envelope.asOf,
      risks,
      warnings: envelope.warnings,
    };
  });

  app.get<{ Params: { address: string } }>("/v1/address/:address/portfolio", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ADDRESS",
            "Invalid Stacks address",
            parsed.error.issues[0]?.message ?? "Invalid address",
          ),
        );
    const envelope = await positionsFor(parsed.data);
    return (await portfolioFor(parsed.data, envelope)).portfolio;
  });

  app.get<{ Params: { address: string } }>("/v1/address/:address/overview", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ADDRESS",
            "Invalid Stacks address",
            parsed.error.issues[0]?.message ?? "Invalid address",
          ),
        );
    const envelope = await positionsFor(parsed.data);
    const { risks, portfolio } = await portfolioFor(parsed.data, envelope);
    const rules = await productStore.alertRules(parsed.data);
    for (const rule of rules) await productStore.putOccurrences(occurrencesForRule(rule, risks, now()));
    return {
      address: parsed.data,
      positions: envelope,
      risks,
      portfolio,
    };
  });

  app.get("/v1/alerts", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    return {
      address: session.address,
      rules: await productStore.alertRules(session.address),
      occurrences: await productStore.alertOccurrences(session.address),
    };
  });

  app.post("/v1/alerts/rules", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const parsed = alertRuleSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ALERT_RULE",
            "Invalid alert rule",
            parsed.error.issues.map((issue) => issue.message).join(", "),
          ),
        );
    const rule = createAlertRule({ address: session.address, ...parsed.data }, now());
    await productStore.putAlertRule(rule);
    const envelope = await positionsFor(session.address);
    const occurrences = occurrencesForRule(rule, evaluateRisks(envelope.positions, now()), now());
    await productStore.putOccurrences(occurrences);
    return reply.code(201).send({ rule, occurrences });
  });

  async function planProtectiveAction(input: z.infer<typeof actionPlanSchema>) {
    const envelope = await positionsFor(input.address);
    const position = envelope.positions.find((candidate) => candidate.id === input.positionId);
    if (!position)
      return {
        error: problem(404, "POSITION_NOT_FOUND", "Position not found", "Refresh positions and retry."),
        status: 404 as const,
      };
    if (position.type !== "lending")
      return {
        error: problem(409, "ACTION_UNSUPPORTED", "Action unsupported", "Repay requires a lending position."),
        status: 409 as const,
      };
    const risk = evaluateRisks([position], now())[0];
    if (!risk)
      return {
        error: problem(
          409,
          "RISK_UNAVAILABLE",
          "Risk unavailable",
          "No current risk result exists for this position.",
        ),
        status: 409 as const,
      };
    const intent =
      dataMode === "fixture"
        ? planRepay(position, risk, input.amountAtomic, envelope.asOf.stacksBlockHeight, now())
        : planZestMainnetRepay(
            input.address,
            position,
            risk,
            input.amountAtomic,
            envelope.asOf.stacksBlockHeight,
            await activeManifest(),
            now(),
          );
    return { intent, status: 200 as const };
  }

  app.post("/v1/actions/plan", async (request, reply) => {
    const parsed = actionPlanSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ACTION",
            "Invalid action request",
            parsed.error.issues.map((issue) => issue.message).join(", "),
          ),
        );
    const planned = await planProtectiveAction(parsed.data);
    if ("error" in planned) return reply.code(planned.status).send(planned.error);
    // Public previews are deliberately stateless. Authentication and persistence
    // happen only after the user asks RiskOS to prepare wallet parameters. Call
    // arguments, post-conditions, and the executable integrity hash are withheld.
    const { intentHash: _intentHash, workflowState: _workflowState, ...preview } = planned.intent;
    return {
      ...preview,
      calls: [],
      warnings: [
        ...preview.warnings,
        "Wallet parameters are withheld until address ownership is authenticated and current evidence is recalculated.",
      ],
    };
  });

  app.post("/v1/actions/intents", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const parsed = actionPlanSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_ACTION",
            "Invalid action request",
            parsed.error.issues.map((issue) => issue.message).join(", "),
          ),
        );
    if (session.address !== parsed.data.address)
      return reply
        .code(403)
        .send(
          problem(
            403,
            "ADDRESS_OWNERSHIP_REQUIRED",
            "Address ownership required",
            "The action address must match the authenticated wallet.",
          ),
        );
    const planned = await planProtectiveAction(parsed.data);
    if ("error" in planned) return reply.code(planned.status).send(planned.error);
    const intent = planned.intent;
    await productStore.putIntent({
      intent,
      address: session.address,
      intentHash: intent.intentHash!,
      state: intent.workflowState === "blocked" ? "blocked" : "planned",
      txid: null,
      updatedAt: now().toISOString(),
    });
    return reply.code(201).send(intent);
  });

  app.post<{ Params: { intentId: string } }>(
    "/v1/actions/:intentId/wallet-request",
    async (request, reply) => {
      const session = await sessionFor(request, reply);
      if (!session) return;
      const stored = await productStore.intent(request.params.intentId);
      if (!stored)
        return reply
          .code(404)
          .send(problem(404, "INTENT_NOT_FOUND", "Intent not found", "Prepare a fresh protective action."));
      if (stored.address !== session.address)
        return reply
          .code(403)
          .send(
            problem(
              403,
              "INTENT_FORBIDDEN",
              "Intent forbidden",
              "The intent belongs to a different wallet session.",
            ),
          );
      try {
        const tip = options.dataFoundation ? await options.dataFoundation.canonicalTip(network) : null;
        const walletRequest = walletRequestForIntent(
          stored.intent,
          now(),
          dataMode === "fixture"
            ? stored.intent.simulation.stateBlock
            : (tip?.height ?? Number.MAX_SAFE_INTEGER),
        );
        await productStore.updateIntent(stored.intent.intentId, "wallet-requested", null, now());
        return walletRequest;
      } catch (error) {
        await productStore.updateIntent(stored.intent.intentId, "blocked", null, now());
        return reply
          .code(409)
          .send(
            problem(
              409,
              "INTENT_BLOCKED",
              "Intent blocked",
              error instanceof Error ? error.message : "Intent validation failed",
            ),
          );
      }
    },
  );

  app.post<{ Params: { intentId: string } }>("/v1/actions/:intentId/submissions", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const parsed = submissionSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send(
          problem(
            400,
            "INVALID_TRANSACTION_ID",
            "Invalid transaction ID",
            "A 32-byte hexadecimal transaction ID is required.",
          ),
        );
    const stored = await productStore.intent(request.params.intentId);
    if (!stored)
      return reply
        .code(404)
        .send(problem(404, "INTENT_NOT_FOUND", "Intent not found", "Prepare a fresh protective action."));
    if (stored.address !== session.address)
      return reply
        .code(403)
        .send(
          problem(
            403,
            "INTENT_FORBIDDEN",
            "Intent forbidden",
            "The intent belongs to a different wallet session.",
          ),
        );
    if (stored.intent.executionMode === "shadow")
      return reply
        .code(409)
        .send(
          problem(
            409,
            "BROADCAST_DISABLED",
            "Broadcast disabled",
            "Mainnet actions remain in the mandatory shadow period.",
          ),
        );
    if (stored.state !== "wallet-requested")
      return reply
        .code(409)
        .send(
          problem(
            409,
            "INVALID_INTENT_STATE",
            "Invalid intent state",
            "Request the wallet payload before recording a submission.",
          ),
        );
    const state = dataMode === "fixture" ? "confirmed" : "submitted";
    const updated = await productStore.updateIntent(
      stored.intent.intentId,
      state,
      parsed.data.txid.toLowerCase(),
      now(),
    );
    return reply.code(202).send({
      intentId: stored.intent.intentId,
      state: updated?.state,
      txid: updated?.txid,
      reconciliation: dataMode === "fixture" ? "fixture-confirmed" : "pending-canonical-evidence",
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    ) {
      return reply
        .code(error.statusCode)
        .send(problem(error.statusCode, "INVALID_REQUEST", "Invalid request", error.message));
    }
    return reply
      .code(500)
      .send(problem(500, "INTERNAL_ERROR", "Internal error", "The request could not be completed safely."));
  });

  return app;
}
