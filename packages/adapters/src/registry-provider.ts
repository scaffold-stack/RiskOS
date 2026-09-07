import type { RegistryManifest } from "../../data-foundation/src/registry.js";

export type RegistryManifestProvider = () => Promise<RegistryManifest | null>;

export function enabledProtocolEntries(manifest: RegistryManifest | null, protocol: string) {
  return manifest?.entries.filter((entry) => entry.enabled && entry.protocol === protocol) ?? [];
}
