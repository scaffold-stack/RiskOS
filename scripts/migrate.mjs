import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const directory = resolve("infra/postgres/migrations");
const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
const sql = postgres(databaseUrl, { max: 1 });

try {
  for (const file of files) {
    const migration = await readFile(resolve(directory, file), "utf8");
    await sql.unsafe(migration);
    console.log(`applied ${file}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
