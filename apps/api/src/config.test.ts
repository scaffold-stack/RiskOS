import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./config.js";

describe("production configuration", () => {
  it("defaults to the official Emily API and a configurable Esplora-compatible Bitcoin source", () => {
    expect(loadRuntimeConfig({})).toMatchObject({ SBTC_EMILY_URL: "https://sbtc-emily.com", BITCOIN_ESPLORA_URL: "https://mempool.space/api" });
  });

  it("refuses to expose fixtures in production", () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", DATA_MODE: "fixture", WEB_ORIGIN: "https://riskos.example" })).toThrow(/DATA_MODE=live/);
  });

  it("requires an explicit production browser origin", () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", DATA_MODE: "live" })).toThrow(/WEB_ORIGIN/);
  });

  it("requires persistence and authenticated ingestion in production", () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", DATA_MODE: "live", WEB_ORIGIN: "https://riskos.example" })).toThrow(/DATABASE_URL/);
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      DATA_MODE: "live",
      WEB_ORIGIN: "https://riskos.example",
      DATABASE_URL: "postgresql://database/riskos",
    })).toThrow(/CHAINHOOK_BEARER_TOKEN/);
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      DATA_MODE: "live",
      WEB_ORIGIN: "https://riskos.example",
      DATABASE_URL: "postgresql://database/riskos",
      CHAINHOOK_BEARER_TOKEN: "a".repeat(32),
    })).toThrow(/OPERATIONS_BEARER_TOKEN/);
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      DATA_MODE: "live",
      WEB_ORIGIN: "https://riskos.example",
      DATABASE_URL: "postgresql://database/riskos",
      CHAINHOOK_BEARER_TOKEN: "a".repeat(32),
      OPERATIONS_BEARER_TOKEN: "b".repeat(32),
    })).toThrow(/REGISTRY_TRUSTED_KEY_FINGERPRINTS/);
  });

  it("refuses unsigned candidate registries in production", () => {
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      DATA_MODE: "live",
      WEB_ORIGIN: "https://riskos.example",
      DATABASE_URL: "postgresql://database/riskos",
      CHAINHOOK_BEARER_TOKEN: "a".repeat(32),
      OPERATIONS_BEARER_TOKEN: "b".repeat(32),
      REGISTRY_TRUSTED_KEY_FINGERPRINTS: "abc",
      REGISTRY_CANDIDATE_PATH: "registry/mainnet/2026-09-04.2.candidate.json",
    })).toThrow(/REGISTRY_CANDIDATE_PATH/);
  });

  it("requires trusted fingerprints when booting a signed registry path", () => {
    expect(() => loadRuntimeConfig({
      REGISTRY_SIGNED_PATH: "registry/mainnet/2026-09-04.2.signed.json",
    })).toThrow(/REGISTRY_TRUSTED_KEY_FINGERPRINTS/);
  });

  it("requires authenticated Stacks API capacity in production", () => {
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      DATA_MODE: "live",
      WEB_ORIGIN: "https://riskos.example",
      DATABASE_URL: "postgresql://database/riskos",
      CHAINHOOK_BEARER_TOKEN: "a".repeat(32),
      OPERATIONS_BEARER_TOKEN: "b".repeat(32),
      REGISTRY_TRUSTED_KEY_FINGERPRINTS: "abc",
    })).toThrow(/HIRO_API_KEY/);
  });

  it("requires an independent state provider but permits the free market quorum without paid Pyth", () => {
    const base = {
      NODE_ENV: "production",
      DATA_MODE: "live",
      WEB_ORIGIN: "https://riskos.example",
      DATABASE_URL: "postgresql://database/riskos",
      CHAINHOOK_BEARER_TOKEN: "a".repeat(32),
      OPERATIONS_BEARER_TOKEN: "b".repeat(32),
      REGISTRY_TRUSTED_KEY_FINGERPRINTS: "abc",
      HIRO_API_KEY: "hiro-key",
    };
    expect(() => loadRuntimeConfig(base)).toThrow(/STACKS_REFERENCE_API_URL/);
    expect(() => loadRuntimeConfig({
      ...base,
      STACKS_REFERENCE_API_URL: "https://reference.example",
    })).not.toThrow();
    expect(() => loadRuntimeConfig({
      ...base,
      STACKS_REFERENCE_API_URL: "https://api.mainnet.hiro.so/",
    })).toThrow(/different deployment/);
    expect(() => loadRuntimeConfig({
      ...base,
      STACKS_REFERENCE_API_URL: "https://docs-demo.stacks-mainnet.quiknode.pro",
    })).toThrow(/public documentation endpoint/);
  });
});
