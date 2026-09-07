import type { Position, ProtocolAdapter } from "../../domain/src/index.js";

const observedAt = "2026-09-03T15:00:00.000Z";
const provenance = [{ source: "fixture" as const, blockHeight: 123_456, observedAt }];

export const DEMO_ADDRESS = "SP000000000000000000002Q6VF78";

export class FixtureZestAdapter implements ProtocolAdapter {
  readonly id = "zest-v2";

  async discover(address: string): Promise<Position[]> {
    if (address !== DEMO_ADDRESS) return [];
    return [
      {
        id: `zest-v2:lending:${address}:market-0`,
        type: "lending",
        protocol: {
          id: "zest",
          version: "v2-fixture",
          contract: "ST000000000000000000002AMW42H.riskos-zest-fixture",
        },
        collateral: {
          asset: "sBTC",
          amountAtomic: "60000000",
          decimals: 8,
          valueUsd: "60000.00",
        },
        debt: {
          asset: "USDCx",
          amountAtomic: "45000000000",
          decimals: 6,
          valueUsd: "45000.00",
        },
        parameters: {
          liquidationThresholdBps: 8000,
          maximumLtvBps: 7000,
        },
        provenance,
        confidence: {
          state: "estimated",
          score: 0.7,
          reasons: ["Deterministic demo fixture; not live protocol state"],
        },
      },
    ];
  }
}

export class FixtureBitflowAdapter implements ProtocolAdapter {
  readonly id = "bitflow";

  async discover(address: string): Promise<Position[]> {
    if (address !== DEMO_ADDRESS) return [];
    return [
      {
        id: `bitflow:liquidity:${address}:sbtc-usdcx-0`,
        type: "liquidity",
        protocol: {
          id: "bitflow",
          version: "fixture-v1",
          contract: "ST000000000000000000002AMW42H.riskos-bitflow-fixture",
        },
        token0: {
          asset: "sBTC",
          amountAtomic: "10000000",
          decimals: 8,
          valueUsd: "10000.00",
        },
        token1: {
          asset: "USDCx",
          amountAtomic: "10000000000",
          decimals: 6,
          valueUsd: "10000.00",
        },
        lowerPrice: "92000",
        upperPrice: "105000",
        currentPrice: "100000",
        exitSlippageBps: 135,
        earnings: {
          annualizedRateBps: 1_200,
          rateKind: "provider-apy",
          earnedToDateUsd: null,
          observedAtBlock: provenance[0]!.blockHeight ?? 0,
          meaning: "Deterministic fixture yield; not live protocol evidence",
        },
        provenance,
        confidence: {
          state: "estimated",
          score: 0.7,
          reasons: ["Deterministic demo fixture; not an executable quote"],
        },
      },
    ];
  }
}

export class FixtureWalletAdapter implements ProtocolAdapter {
  readonly id = "stacks-wallet";

  async discover(address: string): Promise<Position[]> {
    if (address !== DEMO_ADDRESS) return [];
    return [
      {
        id: `stacks:wallet:${address}:stx`,
        type: "wallet",
        protocol: { id: "stacks", version: "fixture-v1" },
        asset: { asset: "STX", amountAtomic: "25000000000", decimals: 6, valueUsd: "5000.00" },
        spendable: true,
        provenance,
        confidence: { state: "estimated", score: 0.8, reasons: ["Deterministic demo wallet balance"] },
      },
      {
        id: `stacks:wallet:${address}:sbtc-locked`,
        type: "wallet",
        protocol: { id: "stacks", version: "fixture-v1" },
        asset: { asset: "sBTC", amountAtomic: "5000000", decimals: 8, valueUsd: "5000.00" },
        spendable: false,
        provenance,
        confidence: {
          state: "estimated",
          score: 0.75,
          reasons: ["Protocol-locked sBTC balance shown as pending/locked, not spendable idle capital"],
        },
      },
    ];
  }
}
