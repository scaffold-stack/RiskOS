import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

export const registryEntrySchema = z.object({
  protocol: z.string().min(1),
  adapterVersion: z.string().min(1),
  network: z.enum(["mainnet", "testnet"]),
  contractPrincipal: z.string().regex(/^(SP|SM|ST|SN)[A-Z0-9]{20,50}\.[a-zA-Z][a-zA-Z0-9-_]{0,127}$/),
  interfaceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  activationBlock: z.number().int().nonnegative(),
  supportedAssets: z.array(z.string()).default([]),
  assetDefinitions: z.array(z.object({
    assetIdentifier: z.string().min(1),
    symbol: z.string().min(1),
    decimals: z.number().int().nonnegative().max(18),
    spendable: z.boolean().default(true),
  })).default([]),
  readOnlyFunctions: z.array(z.string()).default([]),
  transactionFunctions: z.array(z.string()).default([]),
  evidenceUrls: z.array(z.string().url()).min(2),
  reviewedAt: z.string().datetime().optional(),
  reviewer: z.string().min(1).optional(),
  deploymentTransactionId: z.string().regex(/^0x[a-f0-9]{64}$/).optional(),
  enabled: z.boolean(),
});

export const registryManifestSchema = z.object({
  version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
  network: z.enum(["mainnet", "testnet"]),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  entries: z.array(registryEntrySchema),
}).superRefine((manifest, context) => {
  const principals = new Set<string>();
  for (const entry of manifest.entries) {
    if (principals.has(entry.contractPrincipal)) {
      context.addIssue({ code: "custom", message: `Duplicate contract principal: ${entry.contractPrincipal}`, path: ["entries"] });
    }
    principals.add(entry.contractPrincipal);
  }
});

export const signedRegistrySchema = z.object({
  manifest: registryManifestSchema,
  algorithm: z.literal("ed25519"),
  publicKeyPem: z.string().min(1),
  signatureBase64: z.string().min(1),
});

export const registryReviewSchema = z.object({
  reviewer: z.string().min(1),
  reviewedAt: z.string().datetime(),
  notes: z.string().max(500).optional(),
});

/** Dual-reviewed release envelope around a signed registry (reviews are not part of the signed digest). */
export const registryReleaseSchema = z.object({
  kind: z.literal("riskos.registry.release"),
  reviews: z.array(registryReviewSchema).min(2),
  registry: signedRegistrySchema,
});

export type RegistryManifest = z.infer<typeof registryManifestSchema>;
export type SignedRegistry = z.infer<typeof signedRegistrySchema>;
export type RegistryReview = z.infer<typeof registryReviewSchema>;
export type RegistryRelease = z.infer<typeof registryReleaseSchema>;

export function registryDigest(manifest: RegistryManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export function signRegistry(manifest: RegistryManifest, privateKeyPem: string): SignedRegistry {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const signatureBase64 = sign(null, Buffer.from(canonicalJson(manifest)), privateKey).toString("base64");
  return { manifest, algorithm: "ed25519", publicKeyPem, signatureBase64 };
}

export function createRegistryRelease(
  registry: SignedRegistry,
  reviews: RegistryReview[],
): RegistryRelease {
  return registryReleaseSchema.parse({
    kind: "riskos.registry.release",
    reviews,
    registry,
  });
}

/** Accepts a bare signed registry or a dual-reviewed release envelope. */
export function unwrapRegistryPayload(input: unknown): SignedRegistry {
  if (input && typeof input === "object" && "kind" in input && (input as { kind: unknown }).kind === "riskos.registry.release") {
    return registryReleaseSchema.parse(input).registry;
  }
  return signedRegistrySchema.parse(input);
}

export function verifySignedRegistry(input: unknown, trustedKeyFingerprints: ReadonlySet<string>, at = new Date()): SignedRegistry {
  const registry = unwrapRegistryPayload(input);
  const fingerprint = publicKeyFingerprint(registry.publicKeyPem);
  if (!trustedKeyFingerprints.has(fingerprint)) throw new Error("Registry signer is not trusted");
  const valid = verify(
    null,
    Buffer.from(canonicalJson(registry.manifest)),
    createPublicKey(registry.publicKeyPem),
    Buffer.from(registry.signatureBase64, "base64"),
  );
  if (!valid) throw new Error("Registry signature is invalid");
  if (Date.parse(registry.manifest.issuedAt) > at.getTime()) throw new Error("Registry is not active yet");
  if (Date.parse(registry.manifest.expiresAt) <= at.getTime()) throw new Error("Registry has expired");
  if (registry.manifest.entries.some((entry) => entry.network !== registry.manifest.network)) {
    throw new Error("Registry entry network does not match manifest network");
  }
  return registry;
}
