import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createRegistryRelease,
  publicKeyFingerprint,
  registryDigest,
  registryManifestSchema,
  signRegistry,
} from "../packages/data-foundation/src/registry.js";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argsAll(flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
  return values;
}

const candidatePath = process.argv[2];
const keyPath = arg("--key");
const outPath = arg("--out") ?? candidatePath?.replace(/\.candidate\.json$/, ".signed.json");
const reviewers = argsAll("--reviewer");
const notes = arg("--notes");

if (!candidatePath || !keyPath || !outPath || reviewers.length < 2) {
  throw new Error(
    "Usage: npm run registry:sign -- <candidate.json> --key <private.pem> --reviewer <a> --reviewer <b> [--out signed.json] [--notes text]",
  );
}

const uniqueReviewers = [...new Set(reviewers.map((value) => value.trim()).filter(Boolean))];
if (uniqueReviewers.length < 2) {
  throw new Error("Dual review requires two distinct --reviewer identities");
}

const manifest = registryManifestSchema.parse(JSON.parse(await readFile(resolve(candidatePath), "utf8")));
const privateKeyPem = await readFile(resolve(keyPath), "utf8");
const registry = signRegistry(manifest, privateKeyPem);
const reviewedAt = new Date().toISOString();
const release = createRegistryRelease(
  registry,
  uniqueReviewers.map((reviewer) => ({
    reviewer,
    reviewedAt,
    ...(notes ? { notes } : {}),
  })),
);

const resolvedOut = resolve(outPath);
await mkdir(dirname(resolvedOut), { recursive: true });
await writeFile(resolvedOut, `${JSON.stringify(release, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  out: resolvedOut,
  version: manifest.version,
  network: manifest.network,
  digest: registryDigest(manifest),
  signerFingerprint: publicKeyFingerprint(registry.publicKeyPem),
  reviewers: uniqueReviewers,
  entryCount: manifest.entries.length,
}, null, 2));
