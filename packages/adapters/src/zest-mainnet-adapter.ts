import { principalCV, uintCV } from "@stacks/transactions";
import type { Position, ProtocolAdapter } from "../../domain/src/index.js";
import type { VerifiedAssetDefinition } from "./stacks-api-adapter.js";
import {
  asList,
  asPrincipal,
  asTuple,
  asUint,
  bufferToUint,
  responseErrorUint,
  tupleField,
  unwrapOk,
} from "./clarity-values.js";
import { enabledProtocolEntries, type RegistryManifestProvider } from "./registry-provider.js";
import { StacksReadOnlyClient } from "./stacks-read-only-client.js";

const INDEX_PRECISION = 1_000_000_000_000n;
const BPS = 10_000n;
const SECONDS_PER_YEAR = 31_536_000n;
const ASSET_SYMBOLS = [
  "STX",
  "zSTX",
  "sBTC",
  "zsBTC",
  "stSTX",
  "zstSTX",
  "USDCx",
  "zUSDCx",
  "USDH",
  "zUSDH",
  "stSTXbtc",
  "zstSTXbtc",
  "stBTC",
  "zvstBTC",
] as const;
const ERR_UNTRACKED_ACCOUNT = 600_006n;
const DEBT_VAULTS = new Map<number, string>([
  [0, "v0-vault-stx"],
  [2, "v0-vault-sbtc"],
  [4, "v0-vault-ststx"],
  [6, "v0-vault-usdc"],
  [8, "v0-vault-usdh"],
  [10, "v0-vault-ststxbtc"],
  [12, "v0-vault-stbtc"],
]);
const ASSET_VAULTS = new Map<number, string>([
  [0, "v0-vault-stx"],
  [1, "v0-vault-stx"],
  [2, "v0-vault-sbtc"],
  [3, "v0-vault-sbtc"],
  [4, "v0-vault-ststx"],
  [5, "v0-vault-ststx"],
  [6, "v0-vault-usdc"],
  [7, "v0-vault-usdc"],
  [8, "v0-vault-usdh"],
  [9, "v0-vault-usdh"],
  [10, "v0-vault-ststxbtc"],
  [11, "v0-vault-ststxbtc"],
  [12, "v0-vault-stbtc"],
  [13, "v0-vault-stbtc"],
]);

function ceilDiv(numerator: bigint, denominator: bigint) {
  return (numerator + denominator - 1n) / denominator;
}

function projectDebt(amount: bigint, borrowAprBps: bigint, days: 7 | 30 | 90) {
  const elapsed = BigInt(days) * 86_400n;
  return ceilDiv(amount * (BPS * SECONDS_PER_YEAR + borrowAprBps * elapsed), BPS * SECONDS_PER_YEAR);
}

export async function readZestVaultRates(
  pinned: Awaited<ReturnType<StacksReadOnlyClient["pinTip"]>>,
  vault: { contractPrincipal: string; readOnlyFunctions: string[] },
) {
  const cacheKey = `${pinned.blockHeight}:${vault.contractPrincipal}`;
  const cached = zestVaultRateCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const inFlight = zestVaultRateInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const load = (async () => {
    requireReadFunctions(vault, ["get-interest-rate", "get-utilization", "get-fee-reserve"]);
    // Sequential reads per vault — the shared stacksReadGate already caps global
    // concurrency; firing three parallel calls per vault still stampedes under load.
    const borrowRaw = await pinned.call(vault.contractPrincipal, "get-interest-rate", []);
    const utilizationRaw = await pinned.call(vault.contractPrincipal, "get-utilization", []);
    const reserveRaw = await pinned.call(vault.contractPrincipal, "get-fee-reserve", []);
    const borrowAprBps = asUint(unwrapOk(borrowRaw));
    const utilizationBps = asUint(unwrapOk(utilizationRaw));
    const reserveFactorBps = asUint(unwrapOk(reserveRaw));
    if (borrowAprBps > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Zest borrow APR exceeds safe range");
    if (utilizationBps > BPS || reserveFactorBps > BPS)
      throw new Error("Zest rate inputs exceed basis-point bounds");
    const supplyAprBps = (borrowAprBps * utilizationBps * (BPS - reserveFactorBps)) / (BPS * BPS);
    const value = {
      borrowAprBps: Number(borrowAprBps),
      supplyAprBps: Number(supplyAprBps),
      utilizationBps: Number(utilizationBps),
      reserveFactorBps: Number(reserveFactorBps),
    };
    zestVaultRateCache.set(cacheKey, { expiresAt: Date.now() + 60_000, value });
    return value;
  })();

  zestVaultRateInFlight.set(cacheKey, load);
  try {
    return await load;
  } finally {
    zestVaultRateInFlight.delete(cacheKey);
  }
}

type ZestVaultRates = {
  borrowAprBps: number;
  supplyAprBps: number;
  utilizationBps: number;
  reserveFactorBps: number;
};

const zestVaultRateCache = new Map<string, { expiresAt: number; value: ZestVaultRates }>();
const zestVaultRateInFlight = new Map<string, Promise<ZestVaultRates>>();

function requireReadFunctions(
  entry: { contractPrincipal: string; readOnlyFunctions: string[] },
  functions: string[],
) {
  const missing = functions.filter((name) => !entry.readOnlyFunctions.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `active signed registry does not authorize ${entry.contractPrincipal}: ${missing.join(", ")}`,
    );
  }
}

/**
 * Resolve wallet-token identities from the registry-approved Zest asset registry.
 * This keeps contract address, decimals, and symbol bound to one pinned mainnet tip.
 */
export async function discoverZestVerifiedAssets(
  registry: RegistryManifestProvider,
  client: StacksReadOnlyClient,
): Promise<VerifiedAssetDefinition[]> {
  const assets = enabledProtocolEntries(await registry(), "zest-v2").find((entry) =>
    entry.contractPrincipal.endsWith(".v0-assets"),
  );
  if (!assets) return [];
  requireReadFunctions(assets, ["get-status"]);
  const pinned = await client.pinTip();
  const definitions: VerifiedAssetDefinition[] = [];
  // This registry changes rarely and is cached by the API. Resolve it
  // sequentially on a cold start so fourteen assets cannot become a burst of
  // read-only and contract-interface requests against the shared Hiro API.
  for (const [aid, symbol] of ASSET_SYMBOLS.entries()) {
    const statusResponse = await pinned.call(assets.contractPrincipal, "get-status", [uintCV(aid)]);
    if (responseErrorUint(statusResponse) !== null) continue;
    const status = asTuple(unwrapOk(statusResponse));
    const contractPrincipal = asPrincipal(tupleField(status, "addr"));
    let assetIdentifier: string;
    try {
      assetIdentifier = await client.assetIdentifier(contractPrincipal);
    } catch {
      try {
        assetIdentifier = await client.assetIdentifier(contractPrincipal);
      } catch {
        // Native wrappers and non-SIP-010 contracts are not wallet FT identities.
        continue;
      }
    }
    definitions.push({
      assetIdentifier,
      symbol,
      decimals: Number(asUint(tupleField(status, "decimals"))),
      spendable: true,
      ...(symbol.startsWith("z")
        ? {
            positionType: "supply" as const,
            protocol: {
              id: "zest",
              version: assets.adapterVersion,
              contract: contractPrincipal,
            },
          }
        : {}),
    });
  }
  return definitions;
}

export class ZestMainnetAdapter implements ProtocolAdapter {
  readonly id = "zest-v2";

  constructor(
    private readonly registry: RegistryManifestProvider,
    private readonly client: StacksReadOnlyClient,
  ) {}

  async discover(address: string): Promise<Position[]> {
    const entries = enabledProtocolEntries(await this.registry(), "zest-v2");
    const byName = new Map(entries.map((entry) => [entry.contractPrincipal.split(".")[1], entry]));
    const market = byName.get("v0-8-market");
    const positionVault = byName.get("v0-market-vault");
    const assets = byName.get("v0-assets");
    const egroup = byName.get("v0-egroup");
    if (!market || !positionVault || !assets || !egroup) {
      throw new Error("active signed registry does not contain the required Zest v2 read contracts");
    }
    requireReadFunctions(positionVault, ["get-position"]);
    requireReadFunctions(assets, ["get-bitmap", "get-status"]);
    requireReadFunctions(egroup, ["resolve"]);

    const pinned = await this.client.pinTip();
    const enabledMask = asUint(await pinned.call(assets.contractPrincipal, "get-bitmap", []));
    const positionResponse = await pinned.call(positionVault.contractPrincipal, "get-position", [
      principalCV(address),
      uintCV(enabledMask),
    ]);
    const positionError = responseErrorUint(positionResponse);
    if (positionError === ERR_UNTRACKED_ACCOUNT) return [];
    if (positionError !== null) throw new Error(`Zest get-position returned err u${positionError}`);
    const rawPosition = asTuple(unwrapOk(positionResponse));
    const collateralRaw = asList(tupleField(rawPosition, "collateral")).map((item) => {
      const tuple = asTuple(item);
      return { aid: Number(asUint(tupleField(tuple, "aid"))), amount: asUint(tupleField(tuple, "amount")) };
    });
    const debtRaw = asList(tupleField(rawPosition, "debt")).map((item) => {
      const tuple = asTuple(item);
      return { aid: Number(asUint(tupleField(tuple, "aid"))), scaled: asUint(tupleField(tuple, "scaled")) };
    });
    if (collateralRaw.length === 0 && debtRaw.length === 0) return [];
    if (collateralRaw.length === 0) throw new Error("Zest position has debt without collateral");

    const observedAt = new Date().toISOString();
    if (debtRaw.length === 0) {
      // Supply-only wallets skip vault-rate reads here. Overview enrichment applies
      // the shared yield catalog afterward so discovery does not compete with market
      // discovery for the same read-only budget.
      return Promise.all(
        collateralRaw.map(async (leg): Promise<Position> => {
          const status = asTuple(
            unwrapOk(await pinned.call(assets.contractPrincipal, "get-status", [uintCV(leg.aid)])),
          );
          const vaultName = ASSET_VAULTS.get(leg.aid);
          const vault = vaultName ? byName.get(vaultName) : undefined;
          if (!vault) throw new Error(`active signed registry has no supply vault for Zest asset ${leg.aid}`);
          const contractPrincipal = asPrincipal(tupleField(status, "addr"));
          const assetIdentifier = await this.client.assetIdentifier(contractPrincipal).catch(() => undefined);
          return {
            id: `zest-v2:supply:${address}:${asUint(tupleField(rawPosition, "id"))}:${leg.aid}`,
            type: "supply",
            protocol: { id: "zest", version: market.adapterVersion, contract: market.contractPrincipal },
            asset: {
              asset: ASSET_SYMBOLS[leg.aid] ?? `zest-asset-${leg.aid}`,
              amountAtomic: leg.amount.toString(),
              decimals: Number(asUint(tupleField(status, "decimals"))),
              valueUsd: null,
              protocolAssetId: leg.aid,
              contractPrincipal,
              ...(assetIdentifier ? { assetIdentifier } : {}),
            },
            provenance: [{ source: "contract-read", blockHeight: pinned.blockHeight, observedAt }],
            confidence: {
              state: "verified",
              score: 0.9,
              reasons: [
                "Supply share balance was read from the allowlisted position contracts at one pinned Stacks tip",
                "Current supply APR is attached later from the shared yield-market catalog",
                "USD valuation is applied by the pricing service after discovery",
              ],
            },
          };
        }),
      );
    }

    const group = asTuple(
      unwrapOk(await pinned.call(egroup.contractPrincipal, "resolve", [tupleField(rawPosition, "mask")])),
    );
    const liquidationThresholdBps = bufferToUint(tupleField(group, "LTV-LIQ-PARTIAL"));
    const maximumLtvBps = bufferToUint(tupleField(group, "LTV-BORROW"));
    const collateralLegs = await Promise.all(
      collateralRaw.map(async (leg) => {
        const status = asTuple(
          unwrapOk(await pinned.call(assets.contractPrincipal, "get-status", [uintCV(leg.aid)])),
        );
        return {
          asset: ASSET_SYMBOLS[leg.aid] ?? `zest-asset-${leg.aid}`,
          amountAtomic: leg.amount.toString(),
          decimals: Number(asUint(tupleField(status, "decimals"))),
          valueUsd: null as string | null,
          protocolAssetId: leg.aid,
          contractPrincipal: asPrincipal(tupleField(status, "addr")),
        };
      }),
    );

    const debtResults = await Promise.all(
      debtRaw.map(async (leg) => {
        const status = asTuple(
          unwrapOk(await pinned.call(assets.contractPrincipal, "get-status", [uintCV(leg.aid)])),
        );
        const debtVaultName = DEBT_VAULTS.get(leg.aid);
        const debtVault = debtVaultName ? byName.get(debtVaultName) : undefined;
        if (!debtVault) throw new Error(`active signed registry has no debt vault for Zest asset ${leg.aid}`);
        requireReadFunctions(debtVault, ["get-next-index"]);
        const [borrowIndexRaw, rates] = await Promise.all([
          pinned.call(debtVault.contractPrincipal, "get-next-index", []).then((raw) => asUint(unwrapOk(raw))),
          readZestVaultRates(pinned, debtVault),
        ]);
        const debtAmount = ceilDiv(leg.scaled * borrowIndexRaw, INDEX_PRECISION);
        const debtContract = asPrincipal(tupleField(status, "addr"));
        let debtAssetIdentifier: string | undefined;
        try {
          debtAssetIdentifier = await this.client.assetIdentifier(debtContract);
        } catch {
          // Native STX debt is identified by the signed Zest asset registry and
          // contract principal; its wrapper need not expose a SIP-010 token.
        }
        return {
          rates,
          leg: {
            asset: ASSET_SYMBOLS[leg.aid] ?? `zest-asset-${leg.aid}`,
            amountAtomic: debtAmount.toString(),
            decimals: Number(asUint(tupleField(status, "decimals"))),
            valueUsd: null as string | null,
            protocolAssetId: leg.aid,
            contractPrincipal: debtContract,
            ...(debtAssetIdentifier ? { assetIdentifier: debtAssetIdentifier } : {}),
          } satisfies Extract<Position, { type: "lending" }>["debt"],
        };
      }),
    );
    const debtLegs = debtResults.map((item) => item.leg);
    const primaryRates = debtResults[0]?.rates;

    const multiAsset = collateralLegs.length > 1 || debtLegs.length > 1;
    return [
      {
        id: `zest-v2:lending:${address}:${asUint(tupleField(rawPosition, "id"))}`,
        type: "lending" as const,
        protocol: { id: "zest", version: market.adapterVersion, contract: market.contractPrincipal },
        collateral: collateralLegs[0]!,
        debt: debtLegs[0]!,
        legs: { collateral: collateralLegs, debt: debtLegs },
        parameters: { liquidationThresholdBps, maximumLtvBps },
        ...(primaryRates
          ? {
              rates: {
                ...primaryRates,
                observedAtBlock: pinned.blockHeight,
                debtProjections: ([7, 30, 90] as const).map((days) => ({
                  days,
                  amountAtomic: projectDebt(
                    BigInt(debtLegs[0]!.amountAtomic),
                    BigInt(primaryRates!.borrowAprBps),
                    days,
                  ).toString(),
                  assumption: `Deterministic simple-interest projection at the pinned ${primaryRates.borrowAprBps}-bps variable borrow APR; rate changes are not forecast`,
                })),
              },
            }
          : {}),
        provenance: [{ source: "contract-read" as const, blockHeight: pinned.blockHeight, observedAt }],
        confidence: {
          // Multi-leg accounts are still pinned contract reads — labeling them
          // "degraded" falsely suppresses exact portfolio totals for common Zest books.
          state: "verified" as const,
          score: multiAsset ? 0.88 : 0.92,
          reasons: [
            "Position, asset parameters, egroup, and debt index were read at one pinned Stacks tip",
            "Borrow and supply APR inputs were read from the allowlisted debt vault at the same pinned Stacks tip",
            ...(multiAsset
              ? [
                  `Normalized ${collateralLegs.length} collateral and ${debtLegs.length} debt legs; primary repay leg is ${debtLegs[0]!.asset}`,
                ]
              : []),
            "USD valuation is applied by the pricing service after discovery",
          ],
        },
      },
    ];
  }
}
