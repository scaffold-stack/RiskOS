import { describe, expect, it } from "vitest";
import { DEMO_ADDRESS, FixtureZestAdapter } from "../../adapters/src/index.js";
import { validateHistoricalRiskCases } from "./validation.js";

describe("100-case independent risk validation gate", () => {
  it("requires at least 100 unique cases and reports exact mismatches", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0]!;
    const cases = Array.from({ length: 100 }, (_, index) => ({
      caseId: `case-${index}`, evaluatedAt: "2026-09-03T15:00:00.000Z", position: { ...position, id: `${position.id}:${index}` },
      expected: [{ category: "liquidation", severity: "high", score: 73 }],
    }));
    expect(validateHistoricalRiskCases(cases)).toMatchObject({ status: "passed", caseCount: 100, mismatchCount: 0 });
    cases[0]!.expected[0]!.score = 1;
    expect(validateHistoricalRiskCases(cases)).toMatchObject({ status: "failed", mismatchCount: 1 });
    expect(() => validateHistoricalRiskCases(cases.slice(0, 99))).toThrow();
  });
});
