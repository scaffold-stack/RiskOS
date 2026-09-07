import { describe, expect, it } from "vitest";
import { decimalToScaled, ratioToDecimal } from "./money.js";

describe("money primitives", () => {
  it("uses integer arithmetic for deterministic ratios", () => {
    expect(ratioToDecimal(48_000n, 45_000n, 4)).toBe("1.0666");
    expect(ratioToDecimal(-3_687_587n, 100n, 2)).toBe("-36875.87");
    expect(ratioToDecimal(1n, -2n, 2)).toBe("-0.5");
    expect(ratioToDecimal(-1n, -2n, 2)).toBe("0.5");
    expect(ratioToDecimal(1n, 0n)).toBeNull();
  });

  it("converts decimal strings without floating point", () => {
    expect(decimalToScaled("1.23456789")).toBe(123_456_789n);
    expect(decimalToScaled("-2.5", 4)).toBe(-25_000n);
  });
});
