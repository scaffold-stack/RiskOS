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
  bitflowAppApiUrl: config.BITFLOW_APP_API_URL,
  bitflowQuotesApiUrl: config.BITFLOW_QUOTES_API_URL,
  sbtcEmilyUrl: config.SBTC_EMILY_URL,
  bitcoinEsploraUrl: config.BITCOIN_ESPLORA_URL,
  logger: true,
  registryMode,
  ...(dataFoundation ? { dataFoundation } : {}),
  ...(config.CHAINHOOK_BEARER_TOKEN ? { chainhookBearerToken: config.CHAINHOOK_BEARER_TOKEN } : {}),
  ...(config.OPERATIONS_BEARER_TOKEN ? { operationsBearerToken: config.OPERATIONS_BEARER_TOKEN } : {}),
  ...(dataFoundation ? { reconciler: new StacksBlockReconciler(dataFoundation, config.STACKS_API_URL, fetch, config.HIRO_API_KEY) } : {}),
  ...(config.HIRO_API_KEY ? { hiroApiKey: config.HIRO_API_KEY } : {}),
  ...(config.PYTH_HERMES_TOKEN ? {
    pythHermesToken: config.PYTH_HERMES_TOKEN,
    pythHermesUrl: config.PYTH_HERMES_URL,
    priceMaximumDivergenceBps: config.PRICE_MAX_DIVERGENCE_BPS,
  } : {}),
  ...(registryStore ? { registryStore } : {}),
  ...(sql ? { productStore: new PostgresProductStore(sql) } : {}),
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
