import { principalCV } from "@stacks/transactions";
import type { Position, ProtocolAdapter } from "../../domain/src/index.js";
import {
  asList,
  asOptional,
  asPrincipal,
  asTuple,
  asUint,
  tupleField,
} from "./clarity-values.js";
import type { RegistryManifestProvider } from "./registry-provider.js";
import type { StacksReadOnlyClient } from "./stacks-read-only-client.js";

const REQUIRED_STATE_READS = [
  "get-user-position",
  "get-user-collateral",
  "get-collateral",
  "get-debt-params",
  "convert-to-assets",
  "get-balance",
] as const;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Granite debt-share denominator is zero");
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/**
 * Reads Granite borrower state directly from the registry-approved market state
 * contract. Granite stores collateral and debt shares internally, so wallet
 * token balances alone cannot discover a borrower position.
 */
export class GraniteMainnetAdapter implements ProtocolAdapter {
  readonly id = "granite";

  constructor(
    private readonly registry: RegistryManifestProvider,
    private readonly client: StacksReadOnlyClient,
  ) {}

  async discover(address: string): Promise<Position[]> {
    const manifest = await this.registry();
    const state = manifest?.entries.find(
      (entry) =>
        entry.enabled &&
        entry.network === "mainnet" &&
        entry.protocol === "granite" &&
        entry.contractPrincipal.endsWith(".state-v1"),
    );
    if (!state) return [];
    const missing = REQUIRED_STATE_READS.filter((name) => !state.readOnlyFunctions.includes(name));
    if (missing.length) throw new Error(`Granite registry entry is missing read functions: ${missing.join(", ")}`);

    const pinned = await this.client.pinTip();
    const positionValue = asOptional(
      await pinned.call(state.contractPrincipal, "get-user-position", [principalCV(address)]),
    );
    if (!positionValue) return [];
    const position = asTuple(positionValue);
    const collateralPrincipals = asList(tupleField(position, "collaterals")).map(asPrincipal);
    const debtShares = asUint(tupleField(position, "debt-shares"));
    if (collateralPrincipals.length === 0 && debtShares === 0n) return [];
    // The currently approved Granite market has one collateral. Refuse to
    // compress a future multi-collateral account into misleading single-leg
    // liquidation parameters.
    if (collateralPrincipals.length !== 1) {
      throw new Error(`Granite position has ${collateralPrincipals.length} collateral legs; multi-collateral risk is not yet approved`);
    }

    const collateralPrincipal = collateralPrincipals[0]!;
    const collateralRegistry = manifest?.entries.find(
      (entry) => entry.enabled && entry.contractPrincipal === collateralPrincipal,
    );
    const collateralAsset = collateralRegistry?.assetDefinitions[0];
    if (!collateralAsset) throw new Error(`Granite collateral ${collateralPrincipal} is not registry-approved`);

    const [balanceValue, settingsValue, debtParamsValue] = await Promise.all([
      pinned.call(state.contractPrincipal, "get-user-collateral", [principalCV(address), principalCV(collateralPrincipal)]),
      pinned.call(state.contractPrincipal, "get-collateral", [principalCV(collateralPrincipal)]),
      pinned.call(state.contractPrincipal, "get-debt-params", []),
    ]);
    const balanceOptional = asOptional(balanceValue);
    const settingsOptional = asOptional(settingsValue);
    if (!balanceOptional || !settingsOptional) throw new Error("Granite position references missing collateral state");
    const balance = asUint(tupleField(asTuple(balanceOptional), "amount"));
    const settings = asTuple(settingsOptional);
    const debtParams = asTuple(debtParamsValue);
    const openInterest = asUint(tupleField(debtParams, "open-interest"));
    const totalDebtShares = asUint(tupleField(debtParams, "total-debt-shares"));
    if (debtShares > 0n && (openInterest === 0n || totalDebtShares === 0n)) {
      throw new Error("Granite debt shares exist without usable market debt totals");
    }
    const debtAmount = debtShares === 0n ? 0n : ceilDiv(openInterest * debtShares, totalDebtShares);
    const maximumLtvBps = Number(asUint(tupleField(settings, "max-ltv")) / 10_000n);
    const liquidationThresholdBps = Number(asUint(tupleField(settings, "liquidation-ltv")) / 10_000n);
    if (
      maximumLtvBps <= 0 || maximumLtvBps > 10_000 ||
      liquidationThresholdBps <= 0 || liquidationThresholdBps > 10_000
    ) {
      throw new Error("Granite collateral LTV parameters are outside basis-point bounds");
    }
    const marketAsset = manifest!.entries
      .filter((entry) => entry.enabled && entry.protocol === "granite")
      .flatMap((entry) => entry.assetDefinitions)
      .find((asset) => asset.symbol === "aeUSDC");
    if (!marketAsset) throw new Error("Granite market asset aeUSDC is not registry-approved");

    const observedAt = new Date().toISOString();
    return [{
      id: `granite:${state.contractPrincipal}:${address}`,
      type: "lending",
      protocol: { id: "granite", version: state.adapterVersion, contract: state.contractPrincipal },
      collateral: {
        asset: collateralAsset.symbol,
        amountAtomic: balance.toString(),
        decimals: collateralAsset.decimals,
        valueUsd: null,
        contractPrincipal: collateralPrincipal,
        assetIdentifier: collateralAsset.assetIdentifier,
      },
      debt: {
        asset: marketAsset.symbol,
        amountAtomic: debtAmount.toString(),
        decimals: marketAsset.decimals,
        valueUsd: null,
        contractPrincipal: marketAsset.assetIdentifier.slice(0, marketAsset.assetIdentifier.lastIndexOf("::")),
        assetIdentifier: marketAsset.assetIdentifier,
      },
      parameters: { maximumLtvBps, liquidationThresholdBps },
      provenance: [{ source: "contract-read", blockHeight: pinned.blockHeight, observedAt }],
      confidence: {
        state: "verified",
        score: 0.94,
        reasons: [
          "Collateral, collateral policy, user debt shares, and market debt totals were read at one pinned Stacks index block",
          "Debt uses Granite's on-chain round-up conversion: open interest × user debt shares ÷ total debt shares",
        ],
      },
    }];
  }
}
