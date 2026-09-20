import { z } from "zod";

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const runtimeConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATA_MODE: z.enum(["fixture", "live"]).default("fixture"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HOST: z.string().default("0.0.0.0"),
  WEB_ORIGIN: z.preprocess(emptyToUndefined, z.string().optional()),
  STACKS_API_URL: z.string().url().default("https://api.mainnet.hiro.so"),
  STACKS_REFERENCE_API_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  STACKS_REFERENCE_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BITFLOW_APP_API_URL: z.string().url().default("https://bff.bitflowapis.finance/api/app"),
  BITFLOW_QUOTES_API_URL: z.string().url().default("https://bff.bitflowapis.finance/api/quotes"),
  HERMETICA_API_URL: z.string().url().default("https://app.hermetica.fi"),
  DEFILLAMA_YIELDS_API_URL: z.string().url().default("https://yields.llama.fi/pools"),
  SBTC_EMILY_URL: z.string().url().default("https://sbtc-emily.com"),
  BITCOIN_ESPLORA_URL: z.string().url().default("https://mempool.space/api"),
  NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  CHAINHOOK_BEARER_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  OPERATIONS_BEARER_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  HIRO_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  PYTH_HERMES_URL: z.string().url().default("https://pyth.dourolabs.app/hermes"),
  PYTH_HERMES_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  COINGECKO_API_URL: z.string().url().default("https://api.coingecko.com/api/v3"),
  COINGECKO_DEMO_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  COINBASE_EXCHANGE_API_URL: z.string().url().default("https://api.exchange.coinbase.com"),
  PRICE_MAX_DIVERGENCE_BPS: z.coerce.number().int().min(1).max(2_000).default(150),
  PUBLIC_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  REGISTRY_TRUSTED_KEY_FINGERPRINTS: z.preprocess(emptyToUndefined, z.string().optional()),
  REGISTRY_CANDIDATE_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  REGISTRY_SIGNED_PATH: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv): RuntimeConfig {
  const config = runtimeConfigSchema.parse(environment);
  if (config.NODE_ENV === "production" && config.DATA_MODE !== "live") {
    throw new Error("Production refuses to start unless DATA_MODE=live");
  }
  if (config.NODE_ENV === "production" && !config.WEB_ORIGIN) {
    throw new Error("Production requires an explicit WEB_ORIGIN allowlist");
  }
  if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
    throw new Error("Production requires DATABASE_URL for canonical event persistence");
  }
  if (config.NODE_ENV === "production" && !config.CHAINHOOK_BEARER_TOKEN) {
    throw new Error("Production requires CHAINHOOK_BEARER_TOKEN for authenticated ingestion");
  }
  if (config.NODE_ENV === "production" && !config.OPERATIONS_BEARER_TOKEN) {
    throw new Error("Production requires OPERATIONS_BEARER_TOKEN for reconciliation controls");
  }
  if (config.NODE_ENV === "production" && !config.REGISTRY_TRUSTED_KEY_FINGERPRINTS) {
    throw new Error("Production requires REGISTRY_TRUSTED_KEY_FINGERPRINTS for registry activation");
  }
  if (config.NODE_ENV === "production" && config.REGISTRY_CANDIDATE_PATH) {
    throw new Error("Production refuses REGISTRY_CANDIDATE_PATH; use a signed activated registry");
  }
  if (config.REGISTRY_SIGNED_PATH && !config.REGISTRY_TRUSTED_KEY_FINGERPRINTS) {
    throw new Error("REGISTRY_SIGNED_PATH requires REGISTRY_TRUSTED_KEY_FINGERPRINTS");
  }
  if (config.NODE_ENV === "production" && !config.HIRO_API_KEY) {
    throw new Error("Production requires HIRO_API_KEY; anonymous Stacks API quotas are not a reliable mainnet dependency");
  }
  if (config.NODE_ENV === "production" && !config.STACKS_REFERENCE_API_URL) {
    throw new Error("Production requires STACKS_REFERENCE_API_URL for independently sourced position evidence");
  }
  if (
    config.STACKS_REFERENCE_API_URL &&
    config.STACKS_REFERENCE_API_URL.replace(/\/$/, "") === config.STACKS_API_URL.replace(/\/$/, "")
  ) {
    throw new Error("STACKS_REFERENCE_API_URL must be a different deployment from STACKS_API_URL");
  }
  if (
    config.NODE_ENV === "production" &&
    new URL(config.STACKS_REFERENCE_API_URL!).hostname === "docs-demo.stacks-mainnet.quiknode.pro"
  ) {
    throw new Error("Production refuses QuickNode's public documentation endpoint; use an account-owned endpoint");
  }
  return config;
}
