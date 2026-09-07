import { describe, expect, it } from "vitest";
import { formatUsd } from "./portfolio.js";

describe("portfolio display formatting", () => {
  it("places the sign before the currency symbol", () => {
    expect(formatUsd("-36875.87")).toBe("−$36,875.87");
    expect(formatUsd("36875.87")).toBe("$36,875.87");
  });
});
