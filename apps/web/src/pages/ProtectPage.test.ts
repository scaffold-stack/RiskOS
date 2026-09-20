import { describe, expect, it } from "vitest";
import { findSpendableWalletForDebt, repaymentBreakdown } from "./ProtectPage.js";
import type { Position } from "../../../../packages/domain/src/index.js";

describe("repaymentBreakdown", () => {
  it("reports the applied payment, remaining debt, and reduction percentage", () => {
    expect(repaymentBreakdown("49882059044", "9500000000", 6)).toEqual({
      applied: "9,500",
      remaining: "40,382.059044",
      percent: "19.0",
      isFull: false,
    });
  });

  it("caps debt relief at the outstanding debt", () => {
    expect(repaymentBreakdown("49882059044", "50000000000", 6)).toEqual({
      applied: "49,882.059044",
      remaining: "0",
      percent: "100.0",
      isFull: true,
    });
  });
});

describe("findSpendableWalletForDebt", () => {
  const baseWallet = {
    type: "wallet" as const,
    protocol: { id: "stacks" as const, version: "1" },
    spendable: true,
    provenance: [{ source: "stacks-api" as const, observedAt: "2026-09-19T00:00:00.000Z" }],
    confidence: { state: "verified" as const, score: 0.9, reasons: [] },
  };

  it("matches debt by SIP-010 asset identifier when symbols differ in casing", () => {
    const positions: Position[] = [
      {
        ...baseWallet,
        id: "stacks:wallet:SP1:SP.token::ststx",
        asset: {
          asset: "stSTX",
          amountAtomic: "1000000",
          decimals: 6,
          valueUsd: null,
          assetIdentifier: "SP.token::ststx",
        },
      },
    ];
    const match = findSpendableWalletForDebt(positions, {
      asset: "STSTX",
      assetIdentifier: "SP.token::ststx",
    });
    expect(match?.asset.amountAtomic).toBe("1000000");
  });

  it("matches by contract principal embedded in the wallet position id", () => {
    const positions: Position[] = [
      {
        ...baseWallet,
        id: "stacks:wallet:SP1:SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.ststx-token::ststx",
        asset: {
          asset: "stSTX",
          amountAtomic: "2500000",
          decimals: 6,
          valueUsd: null,
        },
      },
    ];
    const match = findSpendableWalletForDebt(positions, {
      asset: "stSTX",
      contractPrincipal: "SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR.ststx-token",
    });
    expect(match?.asset.amountAtomic).toBe("2500000");
  });

  it("prefers spendable STX over locked STX for native debt", () => {
    const positions: Position[] = [
      {
        ...baseWallet,
        id: "stacks:wallet:SP1:stx-locked",
        spendable: false,
        asset: { asset: "STX", amountAtomic: "9000000", decimals: 6, valueUsd: null },
      },
      {
        ...baseWallet,
        id: "stacks:wallet:SP1:stx",
        spendable: true,
        asset: { asset: "STX", amountAtomic: "3000000", decimals: 6, valueUsd: null },
      },
    ];
    const match = findSpendableWalletForDebt(positions, { asset: "STX" });
    expect(match?.asset.amountAtomic).toBe("3000000");
  });

  it("returns null when the wallet does not hold the debt asset", () => {
    const positions: Position[] = [
      {
        ...baseWallet,
        id: "stacks:wallet:SP1:sbtc",
        asset: { asset: "sBTC", amountAtomic: "100", decimals: 8, valueUsd: null },
      },
    ];
    expect(findSpendableWalletForDebt(positions, { asset: "stSTX" })).toBeNull();
  });
});
