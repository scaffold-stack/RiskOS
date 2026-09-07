import { readFile } from "node:fs/promises";
import { registryManifestSchema } from "../packages/data-foundation/src/registry.js";
import { ContractRegistryVerifier } from "../packages/data-foundation/src/contract-verifier.js";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run registry:verify -- <manifest.json>");
const manifest = registryManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
const verifier = new ContractRegistryVerifier(process.env.STACKS_API_URL ?? "https://api.hiro.so", fetch, process.env.HIRO_API_KEY);
const results = await verifier.verifyManifest(manifest);
console.log(JSON.stringify(results, null, 2));
if (results.some((result) => !result.valid)) process.exitCode = 1;
