import { describe, expect, it } from "vitest";
import { positionAssetLabel, positionTypeMatchesFilter } from "./PositionsPage.js";

describe("position tab grouping", () => {
  it("groups Zest supply receipts with lending positions", () => {
    expect(positionTypeMatchesFilter("supply", "lending")).toBe(true);
    expect(positionTypeMatchesFilter("lending", "lending")).toBe(true);
  });

  it("keeps wallet and liquidity positions in their own tabs", () => {
    expect(positionTypeMatchesFilter("wallet", "lending")).toBe(false);
    expect(positionTypeMatchesFilter("liquidity", "lending")).toBe(false);
    expect(positionTypeMatchesFilter("wallet", "wallet")).toBe(true);
    expect(positionTypeMatchesFilter("liquidity", "liquidity")).toBe(true);
  });

  it("uses the SIP-010 token component instead of overflowing contract identifiers", () => {
    expect(positionAssetLabel("SP37WN2BYHKZ90T1ATHTCNG8EFYHS3B49KNGSO2ZK.RALEX::RALEX")).toBe("RALEX");
    expect(positionAssetLabel("sBTC")).toBe("sBTC");
  });
});
