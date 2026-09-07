import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";
import {
  createRegistryRelease,
  publicKeyFingerprint,
  signRegistry,
  type RegistryManifest,
  unwrapRegistryPayload,
  verifySignedRegistry,
} from "./registry.js";

const manifest: RegistryManifest = {
  version: "2026-09-03.1",
  network: "testnet",
  issuedAt: "2026-09-03T00:00:00.000Z",
  expiresAt: "2026-10-03T00:00:00.000Z",
  entries: [{
    protocol: "zest",
    adapterVersion: "v2-test",
    network: "testnet",
    contractPrincipal: "ST000000000000000000002AMW42H.riskos-zest-fixture",
    interfaceHash: `sha256:${"a".repeat(64)}`,
    activationBlock: 100,
    supportedAssets: ["sBTC", "USDCx"],
    assetDefinitions: [],
    readOnlyFunctions: ["get-position"],
    transactionFunctions: ["repay"],
    evidenceUrls: ["https://example.com/repository", "https://example.com/explorer"],
    enabled: true,
  }],
};

describe("signed integration registry", () => {
  it("accepts only a valid Ed25519 signature from a trusted key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const registry = {
      manifest,
      algorithm: "ed25519" as const,
      publicKeyPem,
      signatureBase64: sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64"),
    };
    expect(verifySignedRegistry(registry, new Set([publicKeyFingerprint(publicKeyPem)]), new Date("2026-09-04"))).toEqual(registry);
    expect(() => verifySignedRegistry(registry, new Set(), new Date("2026-09-04"))).toThrow(/not trusted/);
    expect(() => verifySignedRegistry({ ...registry, signatureBase64: Buffer.from("bad").toString("base64") }, new Set([publicKeyFingerprint(publicKeyPem)]), new Date("2026-09-04"))).toThrow(/invalid/);
  });

  it("signs a manifest and verifies dual-reviewed release envelopes", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const registry = signRegistry(manifest, privateKeyPem);
    const release = createRegistryRelease(registry, [
      { reviewer: "alice@riskos.dev", reviewedAt: "2026-09-04T12:00:00.000Z" },
      { reviewer: "bob@riskos.dev", reviewedAt: "2026-09-04T12:05:00.000Z", notes: "On-chain hashes match" },
    ]);
    expect(unwrapRegistryPayload(release)).toEqual(registry);
    expect(verifySignedRegistry(release, new Set([publicKeyFingerprint(registry.publicKeyPem)]), new Date("2026-09-04"))).toEqual(registry);
    expect(() => createRegistryRelease(registry, [{ reviewer: "solo", reviewedAt: "2026-09-04T12:00:00.000Z" }])).toThrow();
  });
});
