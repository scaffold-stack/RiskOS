import { describe, expect, it } from "vitest";
import { runAddressComparisonGate } from "./address-comparison.js";

const addresses = Array.from({ length: 100 }, (_, index) => `SP${String(index).padStart(38, "0")}`);

describe("100-address comparison gate", () => {
  it("refuses a sample smaller than the blueprint gate", async () => {
    const source = { positions: async () => [] };
    await expect(runAddressComparisonGate(addresses.slice(0, 99), source, source)).rejects.toThrow(/at least 100 unique/);
  });

  it("passes only when every address matches independently", async () => {
    const source = { positions: async () => [] };
    await expect(runAddressComparisonGate(addresses, source, source)).resolves.toMatchObject({ addressCount: 100, matchedCount: 100, mismatchCount: 0, passed: true });
  });
});
