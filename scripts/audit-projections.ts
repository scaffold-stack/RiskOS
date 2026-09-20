import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import {
  PROJECTION_PROTOCOLS,
  projectionBackfillContracts,
} from "../packages/data-foundation/src/protocol-projection.js";
import { unwrapRegistryPayload } from "../packages/data-foundation/src/registry.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const network = process.env.NETWORK === "testnet" ? "testnet" : "mainnet";
const signedPath = process.env.REGISTRY_SIGNED_PATH ?? "registry/mainnet/2026-09-13.1.signed.json";
const manifest = unwrapRegistryPayload(JSON.parse(await readFile(resolve(signedPath), "utf8"))).manifest;
if (manifest.network !== network) throw new Error(`Registry ${manifest.version} does not match ${network}`);

const sql = postgres(databaseUrl, { max: 2 });
try {
  const expectedContracts = projectionBackfillContracts(manifest).map((entry) => entry.contractPrincipal);
  const checkpoints = await sql`
    SELECT contract_principal, activation_block, next_offset, events_seen, transactions_ingested,
      status, last_error, pages_completed
    FROM registry_backfill_checkpoints
    WHERE network = ${network} AND registry_version = ${manifest.version}
      AND contract_principal = ANY(${expectedContracts})
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
  const observedContracts = new Set(checkpoints.map((row) => String(row.contract_principal)));
  const missingCheckpoints = expectedContracts.filter((contract) => !observedContracts.has(contract));
  const incomplete = checkpoints.filter((row) => row.status !== "complete");
  const paused = checkpoints.filter((row) => row.status === "paused");
  const failed = checkpoints.filter((row) => row.status === "failed");
  const expectedProtocols = [...PROJECTION_PROTOCOLS];
  const projectedProtocols = new Set(projections.map((row) => String(row.protocol)));
  const missingProtocols = expectedProtocols.filter((protocol) => !projectedProtocols.has(protocol));
  const passed =
    missingCheckpoints.length === 0 &&
    incomplete.length === 0 &&
    issues.length === 0 &&
    missingProtocols.length === 0;
  console.log(
    JSON.stringify(
      {
        passed,
        network,
        registryVersion: manifest.version,
        expectedContractCount: expectedContracts.length,
        checkpointCount: checkpoints.length,
        missingCheckpoints,
        incomplete: incomplete.map((row) => ({
          contract_principal: row.contract_principal,
          status: row.status,
          next_offset: row.next_offset,
          events_seen: row.events_seen,
          pages_completed: row.pages_completed,
          last_error: row.last_error,
        })),
        pausedCount: paused.length,
        failedCount: failed.length,
        projections,
        missingProtocols,
        issues,
        meaning: passed
          ? "Every projection-capable registry contract has exhausted its Hiro event history with zero decode issues."
          : "Backfill is not production-complete until every checkpoint is status=complete (not paused/failed/running).",
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
