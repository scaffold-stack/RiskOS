import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publicKeyFingerprint } from "../packages/data-foundation/src/registry.js";

const outPrefix = resolve(process.argv[2] ?? "keys/dev-release");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const fingerprint = publicKeyFingerprint(publicPem);

await mkdir(dirname(outPrefix), { recursive: true });
await writeFile(`${outPrefix}.ed25519.pem`, privatePem, { mode: 0o600 });
await writeFile(`${outPrefix}.ed25519.pub.pem`, publicPem, { mode: 0o644 });

console.log(JSON.stringify({
  privateKeyPath: `${outPrefix}.ed25519.pem`,
  publicKeyPath: `${outPrefix}.ed25519.pub.pem`,
  fingerprint,
  warning: "Dev/local signing keys only. Production must use an offline or HSM-backed release key that never enters the repo.",
}, null, 2));
