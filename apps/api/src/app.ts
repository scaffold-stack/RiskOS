import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { BitflowMainnetAdapter, DEMO_ADDRESS, discoverZestVerifiedAssets, FixtureBitflowAdapter, FixtureWalletAdapter, FixtureZestAdapter, StacksApiAdapter, StacksReadOnlyClient, ZestMainnetAdapter } from "../../../packages/adapters/src/index.js";
import type { Position, PositionEnvelope, ProtocolAdapter } from "../../../packages/domain/src/index.js";
import { stacksAddressSchema } from "../../../packages/domain/src/index.js";
import { evaluateRisks } from "../../../packages/risk-engine/src/index.js";
import { planRepay, planZestMainnetRepay } from "../../../packages/execution/src/index.js";
import { walletRequestForIntent } from "../../../packages/execution/src/index.js";
import { BitcoinEsploraClient, parseChainhookPayload, reconcileSbtcAddress, SbtcEmilyClient, verifySignedRegistry, type ContractRegistryVerifier, type DataFoundationStore, type RegistryStore, type StacksBlockReconciler } from "../../../packages/data-foundation/src/index.js";
import { timingSafeEqual } from "node:crypto";
import { expiredSessionCookie, sessionCookie, sessionTokenFromHeaders, WalletAuthService } from "../../../packages/auth/src/index.js";
import { createAlertRule, MemoryProductStore, occurrencesForRule, type ProductStore } from "../../../packages/workflows/src/index.js";
import { analyzePortfolio } from "../../../packages/portfolio-engine/src/index.js";
import { BitflowMarketPriceBook, DiaOraclePriceBook, DivergenceAwarePriceBook, enrichPositionsWithUsd, PythHermesPriceBook, ZestVaultExchangeRatePriceBook, type PriceBook } from "../../../packages/pricing/src/index.js";

export interface AppOptions {
  dataMode?: "fixture" | "live";
  stacksApiUrl?: string;
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
  registryVerifier?: ContractRegistryVerifier;
  sbtcEmilyUrl?: string;
  bitcoinEsploraUrl?: string;
  productStore?: ProductStore;
  authAudience?: string;
  priceBook?: PriceBook;
  pythHermesUrl?: string;
  pythHermesToken?: string;
  priceMaximumDivergenceBps?: number;
  registryMode?: "signed" | "candidate" | "none";
  adapters?: ProtocolAdapter[];
}

const actionPlanSchema = z.object({
  address: stacksAddressSchema,
  positionId: z.string().min(1),
  action: z.literal("repay"),
  amountAtomic: z.string().regex(/^\d+$/),
});

const walletChallengeSchema = z.object({ address: stacksAddressSchema });
const walletVerifySchema = z.object({
  challengeId: z.string().min(1), address: stacksAddressSchema,
  publicKey: z.string().min(1), signature: z.string().min(1),
});
const alertRuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  categories: z.array(z.enum(["liquidation", "liquidity", "oracle", "bridge", "unsupported"])).min(1),
  minimumSeverity: z.enum(["info", "low", "medium", "high", "critical"]),
});
const submissionSchema = z.object({ txid: z.string().regex(/^0x[a-fA-F0-9]{64}$/) });

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
    productStore, network, options.authAudience ?? process.env.WEB_ORIGIN?.split(",")[0] ?? "http://localhost:5173",
    dataMode === "fixture" && process.env.NODE_ENV !== "production",
  );
  const activeManifest = async () => (await options.registryStore?.active(network))?.manifest ?? null;
  const emily = new SbtcEmilyClient(options.sbtcEmilyUrl ?? "https://sbtc-emily.com");
  const bitcoin = options.bitcoinEsploraUrl ? new BitcoinEsploraClient(options.bitcoinEsploraUrl) : null;
  const stacksClient = new StacksReadOnlyClient(options.stacksApiUrl ?? "https://api.mainnet.hiro.so", fetch, options.hiroApiKey);
  const diaPriceBook = new DiaOraclePriceBook(stacksClient, undefined, 900, now);
  const consensusPriceBook: PriceBook = options.pythHermesToken
    ? new DivergenceAwarePriceBook(
        diaPriceBook,
        new PythHermesPriceBook(options.pythHermesToken, options.pythHermesUrl, 60, fetch, now),
        options.priceMaximumDivergenceBps ?? 150,
      )
    : diaPriceBook;
  const marketPriceBook = new BitflowMarketPriceBook(
    consensusPriceBook,
    activeManifest,
    options.bitflowAppApiUrl ?? "https://bff.bitflowapis.finance/api/app",
    options.bitflowQuotesApiUrl ?? "https://bff.bitflowapis.finance/api/quotes",
    500,
    fetch,
    now,
  );
  const priceBook = options.priceBook ?? (dataMode === "live"
    ? new ZestVaultExchangeRatePriceBook(
        marketPriceBook,
        stacksClient,
        activeManifest,
        now,
      )
    : undefined);
  let verifiedAssetCache: { version: string; expiresAt: number; assets: Awaited<ReturnType<typeof discoverZestVerifiedAssets>> } | null = null;
  let verifiedAssetLoad: Promise<Awaited<ReturnType<typeof discoverZestVerifiedAssets>>> | null = null;
  const verifiedAssets = async () => {
    const manifest = await activeManifest();
    if (!manifest) return [];
    const staticAssets = manifest.entries.filter((entry) => entry.enabled).flatMap((entry) => entry.assetDefinitions);
    if (verifiedAssetCache?.version === manifest.version && verifiedAssetCache.expiresAt > now().getTime()) {
      return [...staticAssets, ...verifiedAssetCache.assets];
    }
    try {
      verifiedAssetLoad ??= discoverZestVerifiedAssets(activeManifest, stacksClient);
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
  const excludedWalletAssets = async () => (
    (await activeManifest())?.entries
      .filter((entry) => entry.enabled && entry.protocol === "bitflow")
      .map((entry) => `${entry.contractPrincipal}::pool-token`) ?? []
  );
  const adapters: ProtocolAdapter[] = options.adapters ?? (dataMode === "fixture"
    ? [new FixtureZestAdapter(), new FixtureBitflowAdapter(), new FixtureWalletAdapter()]
    : [
        new StacksApiAdapter(
          options.stacksApiUrl ?? "https://api.mainnet.hiro.so",
          fetch,
          options.hiroApiKey,
          verifiedAssets,
          excludedWalletAssets,
        ),
        new ZestMainnetAdapter(activeManifest, stacksClient),
        new BitflowMainnetAdapter(
          activeManifest,
          options.bitflowAppApiUrl ?? "https://bff.bitflowapis.finance/api/app",
          options.bitflowQuotesApiUrl ?? "https://bff.bitflowapis.finance/api/quotes",
          fetch,
          options.stacksApiUrl ?? "https://api.mainnet.hiro.so",
          options.hiroApiKey,
        ),
      ]);

  function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
    const supplied = header?.replace(/^Bearer\s+/i, "") ?? "";
    const target = expected ?? "";
    return supplied.length === target.length && supplied.length > 0
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(target));
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

  const positionLoads = new Map<string, Promise<PositionEnvelope>>();
  const positionCache = new Map<string, { envelope: PositionEnvelope; expiresAt: number }>();

  async function discoverPositions(address: string): Promise<PositionEnvelope> {
    const settled = await Promise.allSettled(adapters.map((adapter) => adapter.discover(address)));
    const positions: Position[] = [];
    const warnings: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") positions.push(...result.value);
      else warnings.push(`${adapters[index]?.id ?? "unknown"} adapter degraded: ${result.reason instanceof Error ? result.reason.message : "unknown error"}`);
    });
    let valued = positions;
    if (priceBook && dataMode === "live") {
      const enriched = await enrichPositionsWithUsd(positions, priceBook);
      valued = enriched.positions;
      warnings.push(...enriched.warnings);
      if (enriched.quotes.some((quote) => quote.source === "fixture")) {
        warnings.push("Live mode received fixture USD quotes; valuations were left incomplete where DIA was unavailable.");
      }
    }
    const canonicalTip = options.dataFoundation ? await options.dataFoundation.canonicalTip(network) : null;
    if (dataMode === "live" && options.registryMode === "candidate") {
      warnings.push("Using unsigned candidate registry for read-only mainnet discovery. Production requires an Ed25519-activated registry.");
    }
    if (dataMode === "live" && !options.hiroApiKey) {
      warnings.push("Hiro API key is not configured; bounded retries are active, but anonymous provider quotas can still degrade mainnet reads.");
    }
    if (dataMode === "live" && !(await activeManifest())) {
      warnings.push("No active registry manifest. Zest/Bitflow reads will fail closed until a candidate or signed registry is loaded.");
    }
    const sourceTipHeights = valued.flatMap((position) => position.provenance)
      .map((item) => item.blockHeight)
      .filter((height): height is number => typeof height === "number");
    const tipHeight = sourceTipHeights.length > 0 ? Math.max(...sourceTipHeights) : undefined;
    if (dataMode === "live" && !canonicalTip && tipHeight === undefined) {
      warnings.push("Stacks block provenance is unavailable from both Chainhook persistence and pinned source reads");
    }
    return {
      address,
      asOf: {
        stacksBlockHeight: dataMode === "fixture" ? 123_456 : canonicalTip?.height ?? tipHeight ?? 0,
        bitcoinBlockHeight: dataMode === "fixture" ? 966_350 : canonicalTip?.burnBlockHeight ?? 0,
        observedAt: now().toISOString(),
      },
      positions: valued,
      warnings,
    };
  }

  async function positionsFor(address: string): Promise<PositionEnvelope> {
    const cached = positionCache.get(address);
    if (cached && cached.expiresAt > Date.now()) return cached.envelope;

    const existing = positionLoads.get(address);
    if (existing) return existing;

    const load = discoverPositions(address);
    positionLoads.set(address, load);
    try {
      const envelope = await load;
      // The UI asks for positions, risk, and portfolio together. This short
      // process-local window coalesces those reads while remaining responsive
      // to newly confirmed blocks and recently active wallets.
      positionCache.set(address, { envelope, expiresAt: Date.now() + 3_000 });
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
    pricing: dataMode === "live"
      ? options.pythHermesToken ? "dia+pyth+bitflow-usdcx+zest-vault" : "dia+bitflow-usdcx+zest-vault"
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
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ADDRESS", "Invalid Stacks address", parsed.error.issues[0]?.message ?? "Invalid address"));
    return reply.code(201).send(await auth.challenge(parsed.data.address, now()));
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const parsed = walletVerifySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_WALLET_PROOF", "Invalid wallet proof", parsed.error.issues.map((issue) => issue.message).join(", ")));
    try {
      const verified = await auth.verify(parsed.data, now());
      reply.header("set-cookie", sessionCookie(verified.token, verified.session.expiresAt, process.env.NODE_ENV === "production"));
      return verified.session;
    } catch (error) {
      return reply.code(401).send(problem(401, "WALLET_PROOF_REJECTED", "Wallet proof rejected", error instanceof Error ? error.message : "Signature verification failed"));
    }
  });

  async function sessionFor(request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }) {
    const session = await auth.authenticate(sessionTokenFromHeaders(request.headers), now());
    if (!session) reply.code(401).send(problem(401, "WALLET_SESSION_REQUIRED", "Wallet session required", "Connect and sign the RiskOS ownership challenge before continuing."));
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
      return reply.code(503).send(problem(503, "INGESTION_UNAVAILABLE", "Ingestion unavailable", "The canonical event store is not configured."));
    }
    if (!bearerMatches(request.headers.authorization, options.chainhookBearerToken)) {
      return reply.code(401).send(problem(401, "INGESTION_UNAUTHORIZED", "Unauthorized", "A valid Chainhook bearer token is required."));
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
      return reply.code(400).send(problem(400, "INVALID_CHAINHOOK_PAYLOAD", "Invalid Chainhook payload", error instanceof Error ? error.message : "Payload rejected"));
    }
  });

  app.get("/v1/system/health", async () => ({
    status: options.dataFoundation ? "available" : "degraded",
    sources: options.dataFoundation ? await options.dataFoundation.sourceHealth() : [],
    warnings: options.dataFoundation ? [] : ["Canonical event store is not configured"],
  }));

  app.post<{ Params: { height: string } }>("/v1/operations/reconcile/stacks/:height", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.operationsBearerToken)) {
      return reply.code(401).send(problem(401, "OPERATIONS_UNAUTHORIZED", "Unauthorized", "A valid operations bearer token is required."));
    }
    if (!options.reconciler) {
      return reply.code(503).send(problem(503, "RECONCILIATION_UNAVAILABLE", "Reconciliation unavailable", "The reconciliation service is not configured."));
    }
    const height = Number(request.params.height);
    if (!Number.isSafeInteger(height) || height < 0) {
      return reply.code(400).send(problem(400, "INVALID_BLOCK_HEIGHT", "Invalid block height", "Height must be a non-negative safe integer."));
    }
    const result = await options.reconciler.reconcile(network, height);
    return reply.code(result.state === "red" ? 409 : 200).send(result);
  });

  app.post("/v1/operations/registry/activate", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.operationsBearerToken)) {
      return reply.code(401).send(problem(401, "OPERATIONS_UNAUTHORIZED", "Unauthorized", "A valid operations bearer token is required."));
    }
    if (!options.registryStore || !options.trustedRegistryKeyFingerprints) {
      return reply.code(503).send(problem(503, "REGISTRY_UNAVAILABLE", "Registry unavailable", "The signed registry store is not configured."));
    }
    try {
      const registry = verifySignedRegistry(request.body, options.trustedRegistryKeyFingerprints, now());
      const verification = options.registryVerifier
        ? await options.registryVerifier.verifyManifest(registry.manifest)
        : [];
      const rejected = verification.filter((result) => !result.valid);
      if (rejected.length > 0) {
        return reply.code(400).send(problem(400, "REGISTRY_ONCHAIN_MISMATCH", "Registry on-chain verification failed", rejected.map((result) => `${result.contractPrincipal}: ${result.errors.join(", ")}`).join("; ")));
      }
      const activation = await options.registryStore.activate(request.body, options.trustedRegistryKeyFingerprints, now());
      return reply.code(202).send({ ...activation, verification });
    } catch (error) {
      return reply.code(400).send(problem(400, "REGISTRY_REJECTED", "Registry rejected", error instanceof Error ? error.message : "Registry activation failed"));
    }
  });

  app.get<{ Params: { address: string } }>("/v1/address/:address/positions", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ADDRESS", "Invalid Stacks address", parsed.error.issues[0]?.message ?? "Invalid address"));
    return positionsFor(parsed.data);
  });

  app.post<{ Params: { address: string } }>("/v1/operations/snapshots/:address", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, options.operationsBearerToken)) {
      return reply.code(401).send(problem(401, "OPERATIONS_UNAUTHORIZED", "Unauthorized", "A valid operations bearer token is required."));
    }
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ADDRESS", "Invalid Stacks address", parsed.error.issues[0]?.message ?? "Invalid address"));
    if (!options.dataFoundation || !options.registryStore) {
      return reply.code(503).send(problem(503, "SNAPSHOTS_UNAVAILABLE", "Snapshots unavailable", "Canonical storage and the active registry are required."));
    }
    const [tip, registry, envelope] = await Promise.all([options.dataFoundation.canonicalTip(network), options.registryStore.active(network), positionsFor(parsed.data)]);
    if (!tip || !registry) return reply.code(409).send(problem(409, "CANONICAL_CONTEXT_UNAVAILABLE", "Canonical context unavailable", "A canonical Chainhook tip and active registry are required."));
    const eligible = envelope.positions.filter((position) => position.provenance.some((item) => item.blockHeight === tip.height));
    const skipped = envelope.positions.filter((position) => !eligible.includes(position)).map((position) => position.id);
    const persisted = await options.dataFoundation.savePositionSnapshots({
      network, address: parsed.data, indexBlockHash: tip.indexBlockHash, blockHeight: tip.height,
      registryVersion: registry.manifest.version, positions: eligible,
    });
    return reply.code(202).send({ indexBlockHash: tip.indexBlockHash, blockHeight: tip.height, persisted, skipped,
      warning: skipped.length ? "Positions without provenance at the canonical tip were not snapshotted" : null });
  });

  app.get<{ Params: { address: string } }>("/v1/address/:address/sbtc-operations", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ADDRESS", "Invalid Stacks address", parsed.error.issues[0]?.message ?? "Invalid address"));
    if (!options.dataFoundation || !bitcoin) {
      return reply.code(503).send(problem(503, "SBTC_RECONCILIATION_UNAVAILABLE", "sBTC reconciliation unavailable", "Canonical event storage and a Bitcoin Esplora provider are required."));
    }
    try {
      const events = await options.dataFoundation.protocolEventsForAddress(network, "sbtc", parsed.data);
      return { address: parsed.data, operations: await reconcileSbtcAddress(parsed.data, events, emily, bitcoin) };
    } catch (error) {
      return reply.code(502).send(problem(502, "SBTC_EVIDENCE_UNAVAILABLE", "sBTC evidence unavailable", error instanceof Error ? error.message : "An evidence source failed"));
    }
  });

  app.get<{ Params: { address: string } }>("/v1/address/:address/risk", async (request, reply) => {
    const parsed = stacksAddressSchema.safeParse(request.params.address);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ADDRESS", "Invalid Stacks address", parsed.error.issues[0]?.message ?? "Invalid address"));
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
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ADDRESS", "Invalid Stacks address", parsed.error.issues[0]?.message ?? "Invalid address"));
    const envelope = await positionsFor(parsed.data);
    let btcReferencePriceUsd: string | null = null;
    if (priceBook && dataMode === "live") {
      try {
        const quote = await priceBook.quote("BTC") ?? await priceBook.quote("sBTC");
        if (quote && quote.source !== "fixture") btcReferencePriceUsd = quote.priceUsd;
      } catch {
        btcReferencePriceUsd = null;
      }
    }
    return analyzePortfolio(envelope, evaluateRisks(envelope.positions, now()), { btcReferencePriceUsd });
  });

  app.get("/v1/alerts", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    return { address: session.address, rules: await productStore.alertRules(session.address), occurrences: await productStore.alertOccurrences(session.address) };
  });

  app.post("/v1/alerts/rules", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const parsed = alertRuleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ALERT_RULE", "Invalid alert rule", parsed.error.issues.map((issue) => issue.message).join(", ")));
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
    if (!position) return { error: problem(404, "POSITION_NOT_FOUND", "Position not found", "Refresh positions and retry."), status: 404 as const };
    if (position.type !== "lending") return { error: problem(409, "ACTION_UNSUPPORTED", "Action unsupported", "Repay requires a lending position."), status: 409 as const };
    const risk = evaluateRisks([position], now())[0];
    if (!risk) return { error: problem(409, "RISK_UNAVAILABLE", "Risk unavailable", "No current risk result exists for this position."), status: 409 as const };
    const intent = dataMode === "fixture"
      ? planRepay(position, risk, input.amountAtomic, envelope.asOf.stacksBlockHeight, now())
      : planZestMainnetRepay(input.address, position, risk, input.amountAtomic, envelope.asOf.stacksBlockHeight, await activeManifest(), now());
    return { intent, status: 200 as const };
  }

  app.post("/v1/actions/plan", async (request, reply) => {
    const parsed = actionPlanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ACTION", "Invalid action request", parsed.error.issues.map((issue) => issue.message).join(", ")));
    const planned = await planProtectiveAction(parsed.data);
    if ("error" in planned) return reply.code(planned.status).send(planned.error);
    // Public previews are deliberately stateless. Authentication and persistence
    // happen only after the user asks RiskOS to prepare wallet parameters. Call
    // arguments, post-conditions, and the executable integrity hash are withheld.
    const { intentHash: _intentHash, workflowState: _workflowState, ...preview } = planned.intent;
    return {
      ...preview,
      calls: [],
      warnings: [...preview.warnings, "Wallet parameters are withheld until address ownership is authenticated and current evidence is recalculated."],
    };
  });

  app.post("/v1/actions/intents", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const parsed = actionPlanSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_ACTION", "Invalid action request", parsed.error.issues.map((issue) => issue.message).join(", ")));
    if (session.address !== parsed.data.address) return reply.code(403).send(problem(403, "ADDRESS_OWNERSHIP_REQUIRED", "Address ownership required", "The action address must match the authenticated wallet."));
    const planned = await planProtectiveAction(parsed.data);
    if ("error" in planned) return reply.code(planned.status).send(planned.error);
    const intent = planned.intent;
    await productStore.putIntent({ intent, address: session.address, intentHash: intent.intentHash!, state: intent.workflowState === "blocked" ? "blocked" : "planned", txid: null, updatedAt: now().toISOString() });
    return reply.code(201).send(intent);
  });

  app.post<{ Params: { intentId: string } }>("/v1/actions/:intentId/wallet-request", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const stored = await productStore.intent(request.params.intentId);
    if (!stored) return reply.code(404).send(problem(404, "INTENT_NOT_FOUND", "Intent not found", "Prepare a fresh protective action."));
    if (stored.address !== session.address) return reply.code(403).send(problem(403, "INTENT_FORBIDDEN", "Intent forbidden", "The intent belongs to a different wallet session."));
    try {
      const tip = options.dataFoundation ? await options.dataFoundation.canonicalTip(network) : null;
      const walletRequest = walletRequestForIntent(stored.intent, now(), dataMode === "fixture" ? stored.intent.simulation.stateBlock : tip?.height ?? Number.MAX_SAFE_INTEGER);
      await productStore.updateIntent(stored.intent.intentId, "wallet-requested", null, now());
      return walletRequest;
    } catch (error) {
      await productStore.updateIntent(stored.intent.intentId, "blocked", null, now());
      return reply.code(409).send(problem(409, "INTENT_BLOCKED", "Intent blocked", error instanceof Error ? error.message : "Intent validation failed"));
    }
  });

  app.post<{ Params: { intentId: string } }>("/v1/actions/:intentId/submissions", async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    const parsed = submissionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(problem(400, "INVALID_TRANSACTION_ID", "Invalid transaction ID", "A 32-byte hexadecimal transaction ID is required."));
    const stored = await productStore.intent(request.params.intentId);
    if (!stored) return reply.code(404).send(problem(404, "INTENT_NOT_FOUND", "Intent not found", "Prepare a fresh protective action."));
    if (stored.address !== session.address) return reply.code(403).send(problem(403, "INTENT_FORBIDDEN", "Intent forbidden", "The intent belongs to a different wallet session."));
    if (stored.intent.executionMode === "shadow") return reply.code(409).send(problem(409, "BROADCAST_DISABLED", "Broadcast disabled", "Mainnet actions remain in the mandatory shadow period."));
    if (stored.state !== "wallet-requested") return reply.code(409).send(problem(409, "INVALID_INTENT_STATE", "Invalid intent state", "Request the wallet payload before recording a submission."));
    const state = dataMode === "fixture" ? "confirmed" : "submitted";
    const updated = await productStore.updateIntent(stored.intent.intentId, state, parsed.data.txid.toLowerCase(), now());
    return reply.code(202).send({ intentId: stored.intent.intentId, state: updated?.state, txid: updated?.txid, reconciliation: dataMode === "fixture" ? "fixture-confirmed" : "pending-canonical-evidence" });
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.code(error.statusCode).send(problem(error.statusCode, "INVALID_REQUEST", "Invalid request", error.message));
    }
    return reply.code(500).send(problem(500, "INTERNAL_ERROR", "Internal error", "The request could not be completed safely."));
  });

  return app;
}
