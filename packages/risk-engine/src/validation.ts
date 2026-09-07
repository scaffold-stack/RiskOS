import { createHash } from "node:crypto";
import { z } from "zod";
import { positionSchema } from "../../domain/src/index.js";
import { canonicalJson } from "../../data-foundation/src/canonical-json.js";
import { evaluateRisks } from "./index.js";

const expectedSchema = z.object({
  category: z.enum(["liquidation", "liquidity", "oracle", "bridge", "unsupported"]),
  severity: z.enum(["info", "low", "medium", "high", "critical"]),
  score: z.number().int().min(0).max(100),
});
const historicalCaseSchema = z.object({
  caseId: z.string().min(1),
  evaluatedAt: z.string().datetime(),
  position: positionSchema,
  expected: z.array(expectedSchema).min(1),
});

export interface RiskValidationArtifact {
  version: "risk-validation-v1";
  caseCount: number;
  matchedCount: number;
  mismatchCount: number;
  status: "passed" | "failed";
  inputDigest: string;
  results: Array<{ caseId: string; matched: boolean; expected: z.infer<typeof expectedSchema>[]; actual: z.infer<typeof expectedSchema>[] }>;
}

export function validateHistoricalRiskCases(input: unknown): RiskValidationArtifact {
  const cases = z.array(historicalCaseSchema).min(100).parse(input);
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) throw new Error("Historical risk case IDs must be unique");
  const results = cases.map((item) => {
    const actual = evaluateRisks([item.position], new Date(item.evaluatedAt)).map(({ category, severity, score }) => ({ category, severity, score }));
    return { caseId: item.caseId, matched: canonicalJson(actual) === canonicalJson(item.expected), expected: item.expected, actual };
  });
  const mismatchCount = results.filter((item) => !item.matched).length;
  return {
    version: "risk-validation-v1", caseCount: cases.length, matchedCount: cases.length - mismatchCount, mismatchCount,
    status: mismatchCount === 0 ? "passed" : "failed",
    inputDigest: createHash("sha256").update(canonicalJson(cases)).digest("hex"), results,
  };
}
