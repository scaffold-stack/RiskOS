import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-04.2.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
if (manifest.network !== network) throw new Error(`Registry ${manifest.version} does not match ${network}`);

const sql = postgres(databaseUrl, { max: 2 });
try {
  const checkpoints = await sql`
    SELECT contract_principal, activation_block, next_offset, events_seen, transactions_ingested, status, last_error
    FROM registry_backfill_checkpoints
    WHERE network = ${network} AND registry_version = ${manifest.version}
    ORDER BY activation_block, contract_principal
  `;
  const issues = await sql`
    SELECT issue.protocol, issue.code, issue.detail, count(*)::integer AS occurrences,
      min(block.height)::bigint AS first_height, max(block.height)::bigint AS last_height
    FROM projection_issues issue
    JOIN chain_blocks block ON block.network = issue.network AND block.index_block_hash = issue.index_block_hash
    WHERE issue.network = ${network} AND issue.canonical AND block.canonical
    GROUP BY issue.protocol, issue.code, issue.detail
    ORDER BY issue.protocol, issue.code, first_height
  `;
  const projections = await sql`
    SELECT protocol, count(*)::integer AS count, count(DISTINCT owner_address)::integer AS owners,
      min(block_height)::bigint AS first_height, max(block_height)::bigint AS last_height
    FROM protocol_projection_events
    WHERE network = ${network} AND canonical
    GROUP BY protocol ORDER BY protocol
  `;
  const expectedContracts = new Set(manifest.entries.filter((entry) => entry.enabled).map((entry) => entry.contractPrincipal));
  const observedContracts = new Set(checkpoints.map((row) => String(row.contract_principal)));
  const missingCheckpoints = [...expectedContracts].filter((contract) => !observedContracts.has(contract));
  const incomplete = checkpoints.filter((row) => row.status !== "complete");
  const expectedProtocols = [...new Set(manifest.entries.filter((entry) => entry.enabled).map((entry) =>
    entry.protocol.startsWith("zest") ? "zest" : entry.protocol))];
  const projectedProtocols = new Set(projections.map((row) => String(row.protocol)));
  const missingProtocols = expectedProtocols.filter((protocol) => !projectedProtocols.has(protocol));
  const passed = missingCheckpoints.length === 0 && incomplete.length === 0 && issues.length === 0 && missingProtocols.length === 0;
  console.log(JSON.stringify({
    passed,
    network,
    registryVersion: manifest.version,
    expectedContractCount: expectedContracts.size,
    checkpointCount: checkpoints.length,
    missingCheckpoints,
    incomplete,
    projections,
    missingProtocols,
    issues,
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
