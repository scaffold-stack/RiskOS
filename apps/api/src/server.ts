import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CandidateRegistryStore,
  ContractRegistryVerifier,
  MemoryRegistryStore,
  PostgresDataFoundationStore,
  PostgresRegistryStore,
  StacksBlockReconciler,
  registryManifestSchema,
  unwrapRegistryPayload,
  type RegistryStore,
} from "../../../packages/data-foundation/src/index.js";
import { PostgresProductStore } from "../../../packages/workflows/src/index.js";
import { PostgresCommercialStore } from "../../../packages/commercial/src/index.js";
import { PostgresAdminAnalyticsStore } from "../../../packages/operations/src/index.js";

const config = loadRuntimeConfig(process.env);
const sql = config.DATABASE_URL ? postgres(config.DATABASE_URL, { max: 10, idle_timeout: 20 }) : undefined;
const dataFoundation = sql ? new PostgresDataFoundationStore(sql) : undefined;
const trustedFingerprints = config.REGISTRY_TRUSTED_KEY_FINGERPRINTS
  ? new Set(config.REGISTRY_TRUSTED_KEY_FINGERPRINTS.split(",").map((value) => value.trim()).filter(Boolean))
  : undefined;

let registryStore: RegistryStore | undefined = sql ? new PostgresRegistryStore(sql) : undefined;
let registryMode: "signed" | "candidate" | "none" = "none";

const activeExisting = registryStore ? await registryStore.active(config.NETWORK) : null;
if (activeExisting) registryMode = "signed";

if (config.DATA_MODE === "live" && config.REGISTRY_SIGNED_PATH && !activeExisting) {
  if (!trustedFingerprints || trustedFingerprints.size === 0) {
    throw new Error("REGISTRY_SIGNED_PATH requires REGISTRY_TRUSTED_KEY_FINGERPRINTS");
  }
  const payload = JSON.parse(await readFile(resolve(config.REGISTRY_SIGNED_PATH), "utf8"));
  unwrapRegistryPayload(payload);
  if (!registryStore) registryStore = new MemoryRegistryStore();
  await registryStore.activate(payload, trustedFingerprints);
  registryMode = "signed";
}

if (config.DATA_MODE === "live" && config.REGISTRY_CANDIDATE_PATH && registryMode !== "signed") {
  if (config.NODE_ENV === "production") {
    throw new Error("Production refuses REGISTRY_CANDIDATE_PATH; activate a signed registry instead");
  }
  const manifest = registryManifestSchema.parse(
    JSON.parse(await readFile(resolve(config.REGISTRY_CANDIDATE_PATH), "utf8")),
  );
  registryStore = new CandidateRegistryStore(manifest);
  registryMode = "candidate";
}

const app = await buildApp({
  dataMode: config.DATA_MODE,
  stacksApiUrl: config.STACKS_API_URL,
  ...(config.STACKS_REFERENCE_API_URL ? {
    stacksReferenceApiUrl: config.STACKS_REFERENCE_API_URL,
    ...(config.STACKS_REFERENCE_API_KEY ? { stacksReferenceApiKey: config.STACKS_REFERENCE_API_KEY } : {}),
  } : {}),
  bitflowAppApiUrl: config.BITFLOW_APP_API_URL,
  bitflowQuotesApiUrl: config.BITFLOW_QUOTES_API_URL,
  hermeticaApiUrl: config.HERMETICA_API_URL,
  stackingDaoApiUrl: config.STACKINGDAO_API_URL,
  defiLlamaYieldsApiUrl: config.DEFILLAMA_YIELDS_API_URL,
  sbtcEmilyUrl: config.SBTC_EMILY_URL,
  bitcoinEsploraUrl: config.BITCOIN_ESPLORA_URL,
  logger: true,
  registryMode,
  ...(dataFoundation ? { dataFoundation } : {}),
  ...(config.CHAINHOOK_BEARER_TOKEN ? { chainhookBearerToken: config.CHAINHOOK_BEARER_TOKEN } : {}),
  ...(config.OPERATIONS_BEARER_TOKEN ? { operationsBearerToken: config.OPERATIONS_BEARER_TOKEN } : {}),
  ...(config.ADMIN_PASSWORD_SCRYPT ? { adminPasswordVerifier: config.ADMIN_PASSWORD_SCRYPT } : {}),
  ...(config.ANALYTICS_HASH_SALT ? { analyticsHashSalt: config.ANALYTICS_HASH_SALT } : {}),
  ...(config.HIRO_CHAINHOOK_UUID ? { hiroChainhookUuid: config.HIRO_CHAINHOOK_UUID } : {}),
  ...(dataFoundation ? { reconciler: new StacksBlockReconciler(dataFoundation, config.STACKS_API_URL, fetch, config.HIRO_API_KEY) } : {}),
  ...(config.HIRO_API_KEY ? { hiroApiKey: config.HIRO_API_KEY } : {}),
  ...(config.PYTH_HERMES_TOKEN ? {
    pythHermesToken: config.PYTH_HERMES_TOKEN,
    pythHermesUrl: config.PYTH_HERMES_URL,
  } : {}),
  priceMaximumDivergenceBps: config.PRICE_MAX_DIVERGENCE_BPS,
  publicRateLimitPerMinute: config.PUBLIC_RATE_LIMIT_PER_MINUTE,
  chainhookBodyLimitBytes: config.CHAINHOOK_BODY_LIMIT_BYTES,
  coinGeckoApiUrl: config.COINGECKO_API_URL,
  coinbaseExchangeApiUrl: config.COINBASE_EXCHANGE_API_URL,
  ...(config.COINGECKO_DEMO_API_KEY ? { coinGeckoDemoApiKey: config.COINGECKO_DEMO_API_KEY } : {}),
  ...(registryStore ? { registryStore } : {}),
  ...(sql ? { productStore: new PostgresProductStore(sql) } : {}),
  ...(sql ? { commercialStore: new PostgresCommercialStore(sql) } : {}),
  ...(sql ? { adminAnalyticsStore: new PostgresAdminAnalyticsStore(sql) } : {}),
  authAudience: config.WEB_ORIGIN?.split(",")[0] ?? "http://localhost:5173",
  registryVerifier: new ContractRegistryVerifier(config.STACKS_API_URL, fetch, config.HIRO_API_KEY),
  ...(trustedFingerprints ? { trustedRegistryKeyFingerprints: trustedFingerprints } : {}),
  network: config.NETWORK,
});
if (sql) app.addHook("onClose", async () => sql.end({ timeout: 5 }));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ dataMode: config.DATA_MODE, registryMode, network: config.NETWORK }, "RiskOS API listening");
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
