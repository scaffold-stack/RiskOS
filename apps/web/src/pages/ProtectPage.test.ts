import { describe, expect, it } from "vitest";
import { repaymentBreakdown } from "./ProtectPage.js";

describe("repaymentBreakdown", () => {
  it("reports the applied payment, remaining debt, and reduction percentage", () => {
    expect(repaymentBreakdown("49882059044", "9500000000", 6)).toEqual({
      applied: "9500",
      remaining: "40382.059044",
      percent: "19.0",
      isFull: false,
    });
  });

  it("caps debt relief at the outstanding debt", () => {
    expect(repaymentBreakdown("49882059044", "50000000000", 6)).toEqual({
      applied: "49882.059044",
      remaining: "0",
      percent: "100.0",
      isFull: true,
    });
  });
});
