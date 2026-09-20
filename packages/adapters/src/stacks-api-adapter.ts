import { z } from "zod";
import { principalCV } from "@stacks/transactions";
import type { Position, ProtocolAdapter } from "../../domain/src/index.js";
import { fetchWithRateLimitRetry, mapWithConcurrency } from "./http-retry.js";
import { asText, asUint, unwrapOk } from "./clarity-values.js";
import type { StacksReadOnlyClient } from "./stacks-read-only-client.js";

export interface VerifiedAssetDefinition {
  assetIdentifier: string;
  symbol: string;
  decimals: number;
  spendable: boolean;
  positionType?: "wallet" | "supply";
  protocol?: { id: string; version: string; contract: string };
}

export type VerifiedAssetProvider = (walletAssetIdentifiers?: readonly string[]) => Promise<VerifiedAssetDefinition[]>;
export type ExcludedWalletAssetProvider = () => Promise<string[]>;

const atomicAmountSchema = z.string().regex(/^\d+$/);
const stxBalanceSchema = z.object({
  balance: atomicAmountSchema,
  available: atomicAmountSchema.optional(),
  locked: z.object({ amount: atomicAmountSchema }).passthrough().nullable().optional(),
}).passthrough();
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
    private readonly consensusClient?: StacksReadOnlyClient,
  ) {}

  async discover(address: string): Promise<Position[]> {
    const headers = {
      accept: "application/json",
      "user-agent": "riskos/0.1",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
    const stxPromise = fetchWithRateLimitRetry(
      this.request,
      `${this.baseUrl}/extended/v3/principals/${address}/balances/stx`,
      { headers },
    );
    const ftFirstPromise = fetchWithRateLimitRetry(
      this.request,
      `${this.baseUrl}/extended/v3/principals/${address}/balances/ft?limit=200`,
      { headers },
    );
    const [stxResponse, ftFirstResponse] = await Promise.all([stxPromise, ftFirstPromise]);
    if (!stxResponse.ok) throw new Error(`Stacks API returned ${stxResponse.status}`);
    if (!ftFirstResponse.ok) throw new Error(`Stacks FT API returned ${ftFirstResponse.status}`);
    const stx = stxBalanceSchema.parse(await stxResponse.json());
    const fungibleTokens: Array<{ asset_identifier: string; balance: string }> = [];
    const firstPage = ftBalancesSchema.parse(await ftFirstResponse.json());
    fungibleTokens.push(...firstPage.results);
    let cursor: string | null = firstPage.cursor?.next ?? null;
    for (let page = 1; page < 10 && cursor; page++) {
      const ftResponse = await fetchWithRateLimitRetry(
        this.request,
        `${this.baseUrl}/extended/v3/principals/${address}/balances/ft?limit=200&cursor=${encodeURIComponent(cursor)}`,
        { headers },
      );
      if (!ftResponse.ok) throw new Error(`Stacks FT API returned ${ftResponse.status}`);
      const parsed = ftBalancesSchema.parse(await ftResponse.json());
      fungibleTokens.push(...parsed.results);
      cursor = parsed.cursor?.next ?? null;
    }
    let tipHeight: number | undefined;
    let pinned: Awaited<ReturnType<StacksReadOnlyClient["pinTip"]>> | null = null;
    try {
      if (this.consensusClient) {
        pinned = await this.consensusClient.pinTip();
        tipHeight = pinned.blockHeight;
      } else {
        const tipResponse = await fetchWithRateLimitRetry(this.request, `${this.baseUrl}/extended/v2/blocks?limit=1`, {
          headers,
        });
        if (tipResponse.ok) {
          const tip = z.object({
            results: z.array(z.object({ height: z.number().int().nonnegative() }).passthrough()).min(1),
          }).passthrough().safeParse(await tipResponse.json());
          if (tip.success) tipHeight = tip.data.results[0]!.height;
        }
      }
    } catch {
      tipHeight = undefined;
      pinned = null;
    }
    const observedAt = new Date().toISOString();
    const verifiedAssets = new Map(
      (await this.verifiedAssets(fungibleTokens.map((asset) => asset.asset_identifier)))
        .map((asset) => [asset.assetIdentifier, asset]),
    );
    const excludedWalletAssets = new Set(await this.excludedWalletAssets());
    const lockedAtomic = stx.locked?.amount ?? "0";
    const availableAtomic = stx.available ?? stx.balance;
    const stxBreakdownReconciled = stx.available === undefined
      || BigInt(availableAtomic) + BigInt(lockedAtomic) === BigInt(stx.balance);
    let stxReconciled = false;
    if (pinned) {
      try {
        // The consensus account endpoint reports liquid STX. Hiro v3 exposes
        // total, available, and PoX-locked quantities separately, so compare
        // the same economic quantity instead of treating locked STX as drift.
        stxReconciled = stxBreakdownReconciled
          && (await pinned.stxBalance(address)) === BigInt(availableAtomic);
      } catch {
        stxReconciled = false;
      }
    }
    const base = {
      protocol: { id: "stacks" as const, version: "api-v1" },
      spendable: true,
      provenance: [{
        source: "stacks-api" as const,
        observedAt,
        ...(tipHeight !== undefined ? { blockHeight: tipHeight } : {}),
      }],
      confidence: stxReconciled
        ? {
            state: "verified" as const,
            score: 0.92,
            reasons: [
              "Extended API spendable STX matches the consensus account state at the pinned index block",
              ...(BigInt(lockedAtomic) > 0n
                ? ["Total STX equals spendable STX plus the provider-reported PoX lock"]
                : []),
              "USD valuation is applied by the pricing service after discovery",
            ],
          }
        : {
            state: "estimated" as const,
            score: 0.75,
            reasons: [
              "Provider spendable STX has not matched a pinned consensus account read",
              "USD valuation is applied by the pricing service after discovery",
            ],
          },
    };

    const positions: Position[] = [{
      ...base,
      id: `stacks:wallet:${address}:stx`,
      type: "wallet",
      asset: { asset: "STX", amountAtomic: availableAtomic, decimals: 6, valueUsd: null },
    }];

    if (BigInt(lockedAtomic) > 0n) {
      positions.push({
        ...base,
        id: `stacks:wallet:${address}:stx-locked`,
        type: "wallet",
        spendable: false,
        asset: { asset: "STX", amountAtomic: lockedAtomic, decimals: 6, valueUsd: null },
        confidence: stxReconciled ? {
          state: "verified",
          score: 0.92,
          reasons: [
            "PoX-locked STX is the verified difference between total and spendable STX in the provider response",
            "Provider spendable STX matches the consensus account state at the pinned index block",
            "USD valuation is applied by the pricing service after discovery",
          ],
        } : base.confidence,
      });
    }

    const candidates = fungibleTokens.filter(
      (amount) => BigInt(amount.balance) !== 0n && !excludedWalletAssets.has(amount.asset_identifier),
    );
    const ftPositions = await mapWithConcurrency(candidates, 4, async (amount) => {
      const verified = verifiedAssets.get(amount.asset_identifier);
      let discoveredMetadata: { symbol: string; decimals: number } | undefined;
      let balanceReconciled = false;
      if (pinned) {
        const separator = amount.asset_identifier.lastIndexOf("::");
        const contractPrincipal = amount.asset_identifier.slice(0, separator);
        try {
          const onChain = asUint(
            unwrapOk(await pinned.call(contractPrincipal, "get-balance", [principalCV(address)])),
          );
          balanceReconciled = onChain === BigInt(amount.balance);
        } catch {
          balanceReconciled = false;
        }
        if (!verified) {
          try {
            const [decimalsRaw, symbolRaw] = await Promise.all([
              pinned.call(contractPrincipal, "get-decimals", []),
              pinned.call(contractPrincipal, "get-symbol", []),
            ]);
            const decimals = asUint(unwrapOk(decimalsRaw));
            if (decimals > 18n) throw new Error("Token decimals exceed display safety bound");
            const symbol = asText(unwrapOk(symbolRaw)).trim();
            if (!symbol) throw new Error("Token symbol is empty");
            discoveredMetadata = { symbol, decimals: Number(decimals) };
          } catch {
            // The raw atomic balance remains visible. Unapproved metadata is
            // never guessed when the SIP-010 reads are unavailable.
          }
        }
      }
      const asset = {
        asset: verified?.symbol ?? discoveredMetadata?.symbol ?? amount.asset_identifier,
        amountAtomic: amount.balance,
        decimals: verified?.decimals ?? discoveredMetadata?.decimals ?? 0,
        valueUsd: null,
        assetIdentifier: amount.asset_identifier,
      };
      const confidence: Position["confidence"] = verified && balanceReconciled ? {
          state: "verified",
          score: 0.93,
          reasons: [
            "Token identity is registry-approved and the provider balance matches get-balance at the pinned index block",
          ],
        } : verified ? {
          state: "estimated",
          score: 0.7,
          reasons: [
            "Token identity is registry-approved, but its provider balance was not reconciled with get-balance at the pinned index block",
          ],
        } : {
          state: "unsupported",
          score: 0.25,
          reasons: [
            ...(discoveredMetadata && balanceReconciled
              ? ["SIP-010 symbol, decimals, and balance were read at the pinned index block"]
              : ["Token decimals and balance could not be fully reconciled at the pinned index block"]),
            "Asset is not present in the approved RiskOS registry, so USD valuation remains unsupported",
          ],
        };
      if (verified?.positionType === "supply" && verified.protocol) {
        return {
          id: `zest-v2:wallet-supply:${address}:${amount.asset_identifier}`,
          type: "supply" as const,
          protocol: verified.protocol,
          asset,
          provenance: base.provenance,
          confidence,
        } satisfies Position;
      }
      return {
        ...base,
        id: `stacks:wallet:${address}:${amount.asset_identifier}`,
        type: "wallet" as const,
        asset,
        spendable: verified?.spendable ?? false,
        confidence,
      } satisfies Position;
    });
    positions.push(...ftPositions);
    return positions;
  }
}
