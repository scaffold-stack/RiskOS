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
  "zstBTC",
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

function projectedDebt(amount: bigint, borrowAprBps: bigint, days: 7 | 30 | 90): bigint {
  const denominator = BPS * SECONDS_PER_YEAR;
  return ceilDiv(amount * (denominator + borrowAprBps * BigInt(days) * 86_400n), denominator);
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
      return Promise.all(
        collateralRaw.map(async (leg): Promise<Position> => {
          const status = asTuple(
            unwrapOk(await pinned.call(assets.contractPrincipal, "get-status", [uintCV(leg.aid)])),
          );
          const vaultName = ASSET_VAULTS.get(leg.aid);
          const vault = vaultName ? byName.get(vaultName) : undefined;
          if (!vault) throw new Error(`active signed registry has no supply vault for Zest asset ${leg.aid}`);
          const [borrowRateCv, utilizationCv, reserveCv] = await Promise.all([
            pinned.call(vault.contractPrincipal, "get-interest-rate", []),
            pinned.call(vault.contractPrincipal, "get-utilization", []),
            pinned.call(vault.contractPrincipal, "get-fee-reserve", []),
          ]);
          const borrowAprBps = asUint(unwrapOk(borrowRateCv));
          const utilizationBps = asUint(unwrapOk(utilizationCv));
          const reserveFactorBps = asUint(unwrapOk(reserveCv));
          const supplyAprBps = (((borrowAprBps * utilizationBps) / BPS) * (BPS - reserveFactorBps)) / BPS;
          const contractPrincipal = asPrincipal(tupleField(status, "addr"));
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
              assetIdentifier: await this.client.assetIdentifier(contractPrincipal),
            },
            rates: {
              supplyAprBps: Number(supplyAprBps),
              utilizationBps: Number(utilizationBps),
              reserveFactorBps: Number(reserveFactorBps),
              observedAtBlock: pinned.blockHeight,
            },
            earnings: {
              annualizedRateBps: Number(supplyAprBps),
              rateKind: "supply-apr",
              earnedToDateUsd: null,
              observedAtBlock: pinned.blockHeight,
              meaning:
                "Projected interest uses the live variable supply APR. Earned-to-date requires a principal or deposit-history baseline.",
            },
            provenance: [{ source: "contract-read", blockHeight: pinned.blockHeight, observedAt }],
            confidence: {
              state: "verified",
              score: 0.92,
              reasons: [
                "Supply balance and live vault rate inputs were read at one pinned Stacks tip",
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
    const collateralLegs = [];
    for (const leg of collateralRaw) {
      const status = asTuple(
        unwrapOk(await pinned.call(assets.contractPrincipal, "get-status", [uintCV(leg.aid)])),
      );
      collateralLegs.push({
        asset: ASSET_SYMBOLS[leg.aid] ?? `zest-asset-${leg.aid}`,
        amountAtomic: leg.amount.toString(),
        decimals: Number(asUint(tupleField(status, "decimals"))),
        valueUsd: null as string | null,
        protocolAssetId: leg.aid,
        contractPrincipal: asPrincipal(tupleField(status, "addr")),
      });
    }

    const debtLegs = [];
    for (const leg of debtRaw) {
      const status = asTuple(
        unwrapOk(await pinned.call(assets.contractPrincipal, "get-status", [uintCV(leg.aid)])),
      );
      const debtVaultName = DEBT_VAULTS.get(leg.aid);
      const debtVault = debtVaultName ? byName.get(debtVaultName) : undefined;
      if (!debtVault) throw new Error(`active signed registry has no debt vault for Zest asset ${leg.aid}`);
      const borrowIndex = asUint(
        unwrapOk(await pinned.call(debtVault.contractPrincipal, "get-next-index", [])),
      );
      const debtAmount = ceilDiv(leg.scaled * borrowIndex, INDEX_PRECISION);
      const debtContract = asPrincipal(tupleField(status, "addr"));
      debtLegs.push({
        asset: ASSET_SYMBOLS[leg.aid] ?? `zest-asset-${leg.aid}`,
        amountAtomic: debtAmount.toString(),
        decimals: Number(asUint(tupleField(status, "decimals"))),
        valueUsd: null as string | null,
        protocolAssetId: leg.aid,
        contractPrincipal: debtContract,
        assetIdentifier: await this.client.assetIdentifier(debtContract),
      });
    }

    const multiAsset = collateralLegs.length > 1 || debtLegs.length > 1;
    const debtVaultName = DEBT_VAULTS.get(debtRaw[0]!.aid);
    const collateralVaultName = ASSET_VAULTS.get(collateralRaw[0]!.aid);
    const rateVault = debtVaultName ? byName.get(debtVaultName) : undefined;
    const supplyVault = collateralVaultName ? byName.get(collateralVaultName) : undefined;
    let rates;
    if (rateVault && supplyVault) {
      const [
        borrowRateCv,
        utilizationCv,
        reserveCv,
        supplyBorrowRateCv,
        supplyUtilizationCv,
        supplyReserveCv,
      ] = await Promise.all([
        pinned.call(rateVault.contractPrincipal, "get-interest-rate", []),
        pinned.call(rateVault.contractPrincipal, "get-utilization", []),
        pinned.call(rateVault.contractPrincipal, "get-fee-reserve", []),
        pinned.call(supplyVault.contractPrincipal, "get-interest-rate", []),
        pinned.call(supplyVault.contractPrincipal, "get-utilization", []),
        pinned.call(supplyVault.contractPrincipal, "get-fee-reserve", []),
      ]);
      const borrowAprBps = asUint(unwrapOk(borrowRateCv));
      const utilizationBps = asUint(unwrapOk(utilizationCv));
      const reserveFactorBps = asUint(unwrapOk(reserveCv));
      const supplyBorrowAprBps = asUint(unwrapOk(supplyBorrowRateCv));
      const supplyUtilizationBps = asUint(unwrapOk(supplyUtilizationCv));
      const supplyReserveFactorBps = asUint(unwrapOk(supplyReserveCv));
      const supplyAprBps =
        (((supplyBorrowAprBps * supplyUtilizationBps) / BPS) * (BPS - supplyReserveFactorBps)) / BPS;
      const primaryDebt = BigInt(debtLegs[0]!.amountAtomic);
      rates = {
        borrowAprBps: Number(borrowAprBps),
        supplyAprBps: Number(supplyAprBps),
        utilizationBps: Number(utilizationBps),
        reserveFactorBps: Number(reserveFactorBps),
        observedAtBlock: pinned.blockHeight,
        debtProjections: ([7, 30, 90] as const).map((days) => ({
          days,
          amountAtomic: projectedDebt(primaryDebt, borrowAprBps, days).toString(),
          assumption: `Current ${Number(borrowAprBps) / 100}% variable borrow APR remains unchanged`,
        })),
      };
    }
    return [
      {
        id: `zest-v2:lending:${address}:${asUint(tupleField(rawPosition, "id"))}`,
        type: "lending" as const,
        protocol: { id: "zest", version: market.adapterVersion, contract: market.contractPrincipal },
        collateral: collateralLegs[0]!,
        debt: debtLegs[0]!,
        legs: { collateral: collateralLegs, debt: debtLegs },
        parameters: { liquidationThresholdBps, maximumLtvBps },
        ...(rates ? { rates } : {}),
        provenance: [{ source: "contract-read" as const, blockHeight: pinned.blockHeight, observedAt }],
        confidence: {
          state: multiAsset ? ("degraded" as const) : ("verified" as const),
          score: multiAsset ? 0.85 : 0.92,
          reasons: [
            "Position, asset parameters, egroup, and debt index were read at one pinned Stacks tip",
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
