import type postgres from "postgres";
import { publicKeyFingerprint, registryDigest, type SignedRegistry, verifySignedRegistry } from "./registry.js";

export interface RegistryActivation {
  version: string;
  network: "mainnet" | "testnet";
  digest: string;
  signerFingerprint: string;
}

export interface RegistryStore {
  activate(input: unknown, trustedKeyFingerprints: ReadonlySet<string>, at?: Date): Promise<RegistryActivation>;
  active(network: "mainnet" | "testnet"): Promise<SignedRegistry | null>;
}

export class MemoryRegistryStore implements RegistryStore {
  private readonly registries = new Map<string, SignedRegistry>();
  private readonly versions = new Map<string, string>();

  async activate(input: unknown, trustedKeyFingerprints: ReadonlySet<string>, at = new Date()): Promise<RegistryActivation> {
    const registry = verifySignedRegistry(input, trustedKeyFingerprints, at);
    const digest = registryDigest(registry.manifest);
    const priorDigest = this.versions.get(registry.manifest.version);
    if (priorDigest && priorDigest !== digest) throw new Error("Registry version is immutable and already has different content");
    this.versions.set(registry.manifest.version, digest);
    this.registries.set(registry.manifest.network, registry);
    return {
      version: registry.manifest.version,
      network: registry.manifest.network,
      digest,
      signerFingerprint: publicKeyFingerprint(registry.publicKeyPem),
    };
  }

  async active(network: "mainnet" | "testnet") {
    return this.registries.get(network) ?? null;
  }
}

/**
 * Read-only bootstrap for local/live development against an unsigned candidate manifest.
 * Production must refuse this path and require Ed25519-activated registries only.
 */
export class CandidateRegistryStore implements RegistryStore {
  constructor(private readonly manifest: import("./registry.js").RegistryManifest) {}

  async activate(): Promise<RegistryActivation> {
    throw new Error("Candidate registry is read-only. Sign the manifest and activate it through the operations endpoint.");
  }

  async active(network: "mainnet" | "testnet"): Promise<SignedRegistry | null> {
    if (this.manifest.network !== network) return null;
    return {
      algorithm: "ed25519",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nCANDIDATE-UNSIGNED\n-----END PUBLIC KEY-----",
      signatureBase64: "CANDIDATE-UNSIGNED",
      manifest: this.manifest,
    };
  }
}

type Sql = ReturnType<typeof postgres>;

export class PostgresRegistryStore implements RegistryStore {
  constructor(private readonly sql: Sql) {}

  async activate(input: unknown, trustedKeyFingerprints: ReadonlySet<string>, at = new Date()): Promise<RegistryActivation> {
    const registry = verifySignedRegistry(input, trustedKeyFingerprints, at);
    const digest = registryDigest(registry.manifest);
    const signerFingerprint = publicKeyFingerprint(registry.publicKeyPem);
    await this.sql.begin(async (tx) => {
      const existing = await tx`SELECT manifest_sha256 FROM registry_versions WHERE version = ${registry.manifest.version}`;
      if (existing[0] && String(existing[0].manifest_sha256) !== digest) {
        throw new Error("Registry version is immutable and already has different content");
      }
      await tx`UPDATE registry_versions SET state = 'superseded' WHERE network = ${registry.manifest.network} AND state = 'active' AND version <> ${registry.manifest.version}`;
      await tx`
        INSERT INTO registry_versions ${tx({
          version: registry.manifest.version,
          network: registry.manifest.network,
          manifest_sha256: digest,
          signer_fingerprint: signerFingerprint,
          signature_base64: registry.signatureBase64,
          manifest: tx.json(registry as never),
          state: "active",
        })}
        ON CONFLICT (version) DO UPDATE SET state = 'active', activated_at = now(), revoked_at = NULL
      `;
    });
    return { version: registry.manifest.version, network: registry.manifest.network, digest, signerFingerprint };
  }

  async active(network: "mainnet" | "testnet"): Promise<SignedRegistry | null> {
    const rows = await this.sql`SELECT manifest FROM registry_versions WHERE network = ${network} AND state = 'active' LIMIT 1`;
    return (rows[0]?.manifest as SignedRegistry | undefined) ?? null;
  }
}
