import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  publicKeyFingerprint,
  registryDigest,
  registryReleaseSchema,
  unwrapRegistryPayload,
  verifySignedRegistry,
} from "../packages/data-foundation/src/registry.js";

const signedPath = process.argv[2];
const apiUrl = (process.env.RISKOS_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const token = process.env.OPERATIONS_BEARER_TOKEN;
const fingerprints = (process.env.REGISTRY_TRUSTED_KEY_FINGERPRINTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!signedPath || !token) {
  throw new Error(
    "Usage: OPERATIONS_BEARER_TOKEN=... REGISTRY_TRUSTED_KEY_FINGERPRINTS=... npm run registry:activate -- <signed-or-release.json>",
  );
}
if (fingerprints.length === 0) {
  throw new Error("REGISTRY_TRUSTED_KEY_FINGERPRINTS must include the release key fingerprint");
}

const payload = JSON.parse(await readFile(resolve(signedPath), "utf8"));
const release = payload?.kind === "riskos.registry.release" ? registryReleaseSchema.parse(payload) : null;
const registry = unwrapRegistryPayload(payload);
verifySignedRegistry(registry, new Set(fingerprints));

const response = await fetch(`${apiUrl}/v1/operations/registry/activate`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(release ?? registry),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(JSON.stringify(body, null, 2));
  process.exitCode = 1;
  throw new Error(`Activation failed with HTTP ${response.status}`);
}

console.log(JSON.stringify({
  activated: body,
  localDigest: registryDigest(registry.manifest),
  localSignerFingerprint: publicKeyFingerprint(registry.publicKeyPem),
  reviews: release?.reviews ?? [],
}, null, 2));
