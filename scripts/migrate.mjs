import { readdir, readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

try {
  await access(resolve(".env"));
  const envFile = await readFile(resolve(".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // Production (Fly) injects DATABASE_URL via secrets; a local .env is optional.
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const directory = resolve("infra/postgres/migrations");
const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
const sql = postgres(databaseUrl, { max: 1, ssl: databaseUrl.includes("sslmode=") || databaseUrl.includes("neon.tech") ? "require" : undefined });

try {
  for (const file of files) {
    const migration = await readFile(resolve(directory, file), "utf8");
    await sql.unsafe(migration);
    console.log(`applied ${file}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
