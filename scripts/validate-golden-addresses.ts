import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { positionSchema } from "../packages/domain/src/index.js";
import { comparablePositions, comparisonDigest, RiskOsHttpPositionSource } from "../packages/data-foundation/src/address-comparison.js";

const fixturePath = process.env.GOLDEN_ADDRESSES_PATH;
const candidateUrl = process.env.RISKOS_CANDIDATE_URL;
if (!fixturePath) throw new Error("GOLDEN_ADDRESSES_PATH is required; RiskOS does not ship invented protocol-approved outputs");
if (!candidateUrl) throw new Error("RISKOS_CANDIDATE_URL is required and must identify the deployed candidate API");

const goldenSchema = z.object({
  version: z.string().min(1),
  approvedBy: z.array(z.string().min(3)).min(1),
  approvedAt: z.string().datetime(),
  evidenceUrls: z.array(z.string().url()).min(2),
  cases: z.array(z.object({
    address: z.string().regex(/^(SP|SM|ST|SN)[A-Z0-9]{20,50}$/),
    protocol: z.enum(["zest", "bitflow", "sbtc"]),
    notes: z.string().min(1),
    expectedPositions: z.array(positionSchema),
  })).min(1),
});

const fixture = goldenSchema.parse(JSON.parse(await readFile(resolve(fixturePath), "utf8")));
const candidate = new RiskOsHttpPositionSource(candidateUrl);
const results = [];
for (const item of fixture.cases) {
  const allPositions = await candidate.positions(item.address);
  const actual = allPositions.filter((position) => position.protocol.id === item.protocol || (
    item.protocol === "zest" && position.protocol.id === "zest-v2"
  ));
  const expectedDigest = comparisonDigest(comparablePositions(item.expectedPositions));
  const actualDigest = comparisonDigest(comparablePositions(actual));
  results.push({
    address: item.address,
    protocol: item.protocol,
    matched: expectedDigest === actualDigest,
    expectedDigest,
    actualDigest,
    expectedCount: item.expectedPositions.length,
    actualCount: actual.length,
  });
}
const mismatchCount = results.filter((item) => !item.matched).length;
console.log(JSON.stringify({
  passed: mismatchCount === 0,
  fixtureVersion: fixture.version,
  approvedBy: fixture.approvedBy,
  approvedAt: fixture.approvedAt,
  evidenceUrls: fixture.evidenceUrls,
  candidateUrl,
  caseCount: results.length,
  mismatchCount,
  results,
}, null, 2));
if (mismatchCount > 0) process.exitCode = 1;
