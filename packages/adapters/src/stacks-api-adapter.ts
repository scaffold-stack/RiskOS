import { z } from "zod";
import type { Position, ProtocolAdapter } from "../../domain/src/index.js";
import { fetchWithRateLimitRetry } from "./http-retry.js";

export interface VerifiedAssetDefinition {
  assetIdentifier: string;
  symbol: string;
  decimals: number;
  spendable: boolean;
}

export type VerifiedAssetProvider = () => Promise<VerifiedAssetDefinition[]>;
export type ExcludedWalletAssetProvider = () => Promise<string[]>;

const stxBalanceSchema = z.object({ balance: z.string().regex(/^\d+$/) }).passthrough();
const ftBalancesSchema = z.object({
  results: z.array(z.object({
    asset_identifier: z.string(),
    balance: z.string().regex(/^\d+$/),
  }).passthrough()),
  cursor: z.object({ next: z.string().nullable().optional() }).passthrough().optional(),
}).passthrough();

export class StacksApiAdapter implements ProtocolAdapter {
  readonly id = "stacks-core";

  constructor(
    private readonly baseUrl: string,
    private readonly request: typeof fetch = fetch,
    private readonly apiKey?: string,
    private readonly verifiedAssets: VerifiedAssetProvider = async () => [],
    private readonly excludedWalletAssets: ExcludedWalletAssetProvider = async () => [],
  ) {}

  async discover(address: string): Promise<Position[]> {
    const headers = {
      accept: "application/json",
      "user-agent": "riskos/0.1",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
    const response = await fetchWithRateLimitRetry(this.request, `${this.baseUrl}/extended/v3/principals/${address}/balances/stx`, {
      headers,
    });
    if (!response.ok) throw new Error(`Stacks API returned ${response.status}`);
    const stx = stxBalanceSchema.parse(await response.json());
    const fungibleTokens: Array<{ asset_identifier: string; balance: string }> = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const suffix = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : "?limit=200";
      const ftResponse = await fetchWithRateLimitRetry(this.request, `${this.baseUrl}/extended/v3/principals/${address}/balances/ft${suffix}`, {
        headers,
      });
      if (!ftResponse.ok) throw new Error(`Stacks FT API returned ${ftResponse.status}`);
      const parsed = ftBalancesSchema.parse(await ftResponse.json());
      fungibleTokens.push(...parsed.results);
      cursor = parsed.cursor?.next ?? null;
      if (!cursor) break;
    }
    let tipHeight: number | undefined;
    try {
      const tipResponse = await fetchWithRateLimitRetry(this.request, `${this.baseUrl}/extended/v2/blocks?limit=1`, {
        headers,
      });
      if (tipResponse.ok) {
        const tip = z.object({
          results: z.array(z.object({ height: z.number().int().nonnegative() }).passthrough()).min(1),
        }).passthrough().safeParse(await tipResponse.json());
        if (tip.success) tipHeight = tip.data.results[0]!.height;
      }
    } catch {
      tipHeight = undefined;
    }
    const observedAt = new Date().toISOString();
    const verifiedAssets = new Map((await this.verifiedAssets()).map((asset) => [asset.assetIdentifier, asset]));
    const excludedWalletAssets = new Set(await this.excludedWalletAssets());
    const base = {
      protocol: { id: "stacks" as const, version: "api-v1" },
      spendable: true,
      provenance: [{
        source: "stacks-api" as const,
        observedAt,
        ...(tipHeight !== undefined ? { blockHeight: tipHeight } : {}),
      }],
      confidence: {
        state: "estimated" as const,
        score: 0.75,
        reasons: [
          "Provider response has not yet been reconciled against an independent node",
          "USD valuation is applied by the pricing service after discovery",
        ],
      },
    };

    const positions: Position[] = [{
      ...base,
      id: `stacks:wallet:${address}:stx`,
      type: "wallet",
      asset: { asset: "STX", amountAtomic: stx.balance, decimals: 6, valueUsd: null },
    }];

    for (const amount of fungibleTokens) {
      // Protocol ownership receipts are normalized by their protocol adapter into
      // underlying economic legs. Emitting the receipt here would double count value.
      if (excludedWalletAssets.has(amount.asset_identifier)) continue;
      const verified = verifiedAssets.get(amount.asset_identifier);
      positions.push({
        ...base,
        id: `stacks:wallet:${address}:${amount.asset_identifier}`,
        type: "wallet",
        asset: {
          asset: verified?.symbol ?? amount.asset_identifier,
          amountAtomic: amount.balance,
          decimals: verified?.decimals ?? 0,
          valueUsd: null,
        },
        spendable: verified?.spendable ?? false,
        confidence: verified ? {
          state: "verified",
          score: 0.95,
          reasons: ["Token identity is pinned directly by the signed registry or resolved from its allowlisted on-chain asset registry"],
        } : {
          state: "unsupported",
          score: 0.25,
          reasons: ["Token decimals and asset registry entry are not verified"],
        },
      });
    }
    return positions;
  }
}
