import { readFile } from "node:fs/promises";
import { MemoryRegistryStore } from "../packages/data-foundation/src/index.js";
import { loadRuntimeConfig } from "../apps/api/src/config.js";

const config = loadRuntimeConfig(process.env);
if (!config.REGISTRY_SIGNED_PATH || !config.REGISTRY_TRUSTED_KEY_FINGERPRINTS) {
  throw new Error("REGISTRY_SIGNED_PATH and REGISTRY_TRUSTED_KEY_FINGERPRINTS are required");
}
const trusted = new Set(config.REGISTRY_TRUSTED_KEY_FINGERPRINTS.split(",").map((value) => value.trim()).filter(Boolean));
const payload = JSON.parse(await readFile(config.REGISTRY_SIGNED_PATH, "utf8"));
const store = new MemoryRegistryStore();
const activation = await store.activate(payload, trusted);
const active = await store.active("mainnet");
console.log(JSON.stringify({
  boot: "ok",
  registryMode: "signed",
  activation,
  version: active?.manifest.version,
  reviews: Array.isArray(payload.reviews) ? payload.reviews.length : 0,
}, null, 2));
