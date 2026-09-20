import { describe, expect, it } from "vitest";
import { formatUsd, humanAmount } from "./portfolio.js";

describe("portfolio display formatting", () => {
  it("places the sign before the currency symbol", () => {
    expect(formatUsd("-36875.87")).toBe("−$36,875.87");
    expect(formatUsd("36875.87")).toBe("$36,875.87");
  });

  it("renders atomic balances with magnitude-aware precision", () => {
    expect(humanAmount("9386875", 6)).toBe("9.3868");
    expect(humanAmount("6387358450", 8)).toBe("63.8735");
    expect(humanAmount("2708583531", 6)).toBe("2,708.58");
    expect(humanAmount("39590", 6)).toBe("0.03959");
    expect(humanAmount("1000000", 6)).toBe("1");
    expect(humanAmount("1000000", 6, 2)).toBe("1");
  });
});
