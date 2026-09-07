import { createHash, randomUUID } from "node:crypto";
import type { LendingPosition, RiskFinding, TransactionIntent, WalletTransactionRequest } from "../../domain/src/index.js";
import { decimalToScaled, ratioToDecimal } from "../../domain/src/money.js";
import { canonicalJson } from "../../data-foundation/src/canonical-json.js";
import type { RegistryManifest } from "../../data-foundation/src/registry.js";
import { Cl, Pc, cvToHex } from "@stacks/transactions";

const FIXTURE_CONTRACT = "ST000000000000000000002AMW42H.riskos-zest-fixture";

export function planRepay(
  position: LendingPosition,
  risk: RiskFinding,
  amountAtomic: string,
  stateBlock: number,
  now = new Date(),
): TransactionIntent {
  const registered = position.protocol.contract === FIXTURE_CONTRACT && position.protocol.version === "v2-fixture";
  const amount = BigInt(amountAtomic);
  const debtAmount = BigInt(position.debt.amountAtomic);
  const validAmount = amount > 0n && amount <= debtAmount;
  const collateralUsd = position.collateral.valueUsd === null ? null : decimalToScaled(position.collateral.valueUsd);
  const debtUsd = position.debt.valueUsd === null ? null : decimalToScaled(position.debt.valueUsd);
  const repayUsd = debtUsd === null || debtAmount === 0n ? null : amount * debtUsd / debtAmount;
  const remainingDebtUsd = debtUsd === null || repayUsd === null ? null : debtUsd - repayUsd;
  const adjustedCollateral = collateralUsd === null ? null : collateralUsd * BigInt(position.parameters.liquidationThresholdBps) / 10_000n;
  const postHealthFactor = adjustedCollateral === null || remainingDebtUsd === null
    ? null
    : remainingDebtUsd === 0n ? "999" : ratioToDecimal(adjustedCollateral, remainingDebtUsd, 4);
  const meetsTarget = postHealthFactor !== null && decimalToScaled(postHealthFactor, 4) >= 13_500n;
  const ready = registered && validAmount && meetsTarget;
  const intentMaterial = `${position.id}:${risk.riskId}:${amountAtomic}:${stateBlock}`;
  const intentId = `int_${createHash("sha256").update(intentMaterial).digest("hex").slice(0, 20)}`;
  const postConditions = [`debt-token-transfer<=${amountAtomic}`, "recipient-must-equal-protocol-contract"];

  const intent: TransactionIntent = {
    intentId: process.env.NODE_ENV === "test" ? intentId : `${intentId}_${randomUUID().slice(0, 8)}`,
    network: "testnet",
    status: ready ? "ready" : "blocked",
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    reason: { riskId: risk.riskId, targetHealthFactor: "1.35" },
    calls: ready ? [{
      contract: position.protocol.contract,
      function: "repay",
      args: [position.id, amountAtomic],
      postConditions,
    }] : [],
    guardrails: { maximumStateAgeSeconds: 30, maximumStateBlockDrift: 2, maximumFeeMicroStx: "100000" },
    simulation: {
      status: ready ? "passed" : "blocked",
      stateBlock,
      postHealthFactor,
    },
    registryVersion: registered ? "fixture-2026-09-03.1" : "unverified",
    adapterVersion: `${position.protocol.id}@${position.protocol.version}`,
    warnings: !registered
      ? ["Contract/version is absent from the verified registry"]
      : !validAmount
        ? ["Repayment must be greater than zero and no larger than current debt"]
        : !meetsTarget
          ? ["Simulation does not reach the required 1.35 health factor"]
          : ["TESTNET FIXTURE ONLY — this intent cannot be broadcast to mainnet"],
    executionMode: "testnet",
    workflowState: ready ? "planned" : "blocked",
  };
  intent.intentHash = transactionIntentHash(intent);
  return intent;
}

export function transactionIntentHash(intent: TransactionIntent): string {
  const { intentHash: _ignored, ...material } = intent;
  return createHash("sha256").update(canonicalJson(material)).digest("hex");
}

export function planZestMainnetRepay(
  address: string,
  position: LendingPosition,
  risk: RiskFinding,
  amountAtomic: string,
  stateBlock: number,
  manifest: RegistryManifest | null,
  now = new Date(),
): TransactionIntent {
  const amount = BigInt(amountAtomic);
  const debtAmount = BigInt(position.debt.amountAtomic);
  const maximumWithAccrualHeadroom = debtAmount + (debtAmount + 999n) / 1_000n;
  const market = manifest?.entries.find((entry) => entry.enabled && entry.network === "mainnet"
    && entry.protocol === "zest-v2" && entry.contractPrincipal === position.protocol.contract
    && entry.transactionFunctions.includes("repay"));
  const debtContract = position.debt.contractPrincipal;
  const assetIdentifier = position.debt.assetIdentifier;
  const metadataReady = Boolean(market && debtContract?.includes(".") && assetIdentifier?.includes("::") && position.debt.protocolAssetId !== undefined);
  const validAmount = amount > 0n && amount <= maximumWithAccrualHeadroom;
  const fullRepay = amount >= debtAmount;
  const collateralUsd = position.collateral.valueUsd === null ? null : decimalToScaled(position.collateral.valueUsd);
  const debtUsd = position.debt.valueUsd === null ? null : decimalToScaled(position.debt.valueUsd);
  const remainingDebtUsd = debtUsd === null || debtAmount === 0n ? null : debtUsd - (amount >= debtAmount ? debtUsd : amount * debtUsd / debtAmount);
  const adjustedCollateral = collateralUsd === null ? null : collateralUsd * BigInt(position.parameters.liquidationThresholdBps) / 10_000n;
  const postHealthFactor = fullRepay ? "999" : adjustedCollateral === null || remainingDebtUsd === null
    ? null : ratioToDecimal(adjustedCollateral, remainingDebtUsd, 4);
  const meetsTarget = fullRepay || (postHealthFactor !== null && decimalToScaled(postHealthFactor, 4) >= 13_500n);
  const ready = metadataReady && validAmount && meetsTarget;
  const intentId = `int_${createHash("sha256").update(`${address}:${position.id}:${risk.riskId}:${amountAtomic}:${stateBlock}:${manifest?.version ?? "none"}`).digest("hex").slice(0, 20)}`;
  const debtSeparator = debtContract?.indexOf(".") ?? -1;
  const assetSeparator = assetIdentifier?.lastIndexOf("::") ?? -1;
  const postConditions = metadataReady ? [Pc.principal(address).willSendLte(amount).ft(assetIdentifier!.slice(0, assetSeparator) as `${string}.${string}`, assetIdentifier!.slice(assetSeparator + 2)) as unknown as Record<string, string>] : [];
  const warnings = !market ? ["Active signed registry does not allowlist Zest v0.8 repay"]
    : !metadataReady ? ["Zest debt-token execution metadata is incomplete"]
    : !validAmount ? ["Repayment is outside the current debt plus 0.1% accrual headroom"]
    : !meetsTarget ? ["Partial repayment needs fresh valuation and must reach the 1.35 target health factor"]
    : ["MAINNET SHADOW — payload is complete but wallet broadcast remains release-gated"];
  const intent: TransactionIntent = {
    intentId: process.env.NODE_ENV === "test" ? intentId : `${intentId}_${randomUUID().slice(0, 8)}`,
    network: "mainnet", status: ready ? "ready" : "blocked",
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    reason: { riskId: risk.riskId, targetHealthFactor: "1.35" },
    calls: ready ? [{ contract: position.protocol.contract, function: "repay", args: [
      cvToHex(Cl.contractPrincipal(debtContract!.slice(0, debtSeparator), debtContract!.slice(debtSeparator + 1))), cvToHex(Cl.uint(amount)), cvToHex(Cl.none()),
    ], postConditions }] : [],
    guardrails: { maximumStateAgeSeconds: 30, maximumStateBlockDrift: 2, maximumFeeMicroStx: "100000" },
    simulation: { status: ready ? "passed" : "blocked", stateBlock, postHealthFactor },
    registryVersion: manifest?.version ?? "unverified", adapterVersion: position.protocol.version,
    warnings, executionMode: "shadow", workflowState: ready ? "planned" : "blocked",
  };
  intent.intentHash = transactionIntentHash(intent);
  return intent;
}

export function walletRequestForIntent(intent: TransactionIntent, now: Date, currentStateBlock: number): WalletTransactionRequest {
  const intentHash = transactionIntentHash(intent);
  const stale = Date.parse(intent.expiresAt) <= now.getTime()
    || currentStateBlock - intent.simulation.stateBlock > intent.guardrails.maximumStateBlockDrift;
  const call = intent.calls[0];
  if (intent.status !== "ready" || intent.simulation.status !== "passed" || stale || !call || intentHash !== intent.intentHash) {
    throw new Error(stale ? "Intent expired or canonical state drift exceeded its limit" : "Intent integrity or simulation validation failed");
  }
  const shadow = intent.executionMode === "shadow";
  return {
    intentId: intent.intentId,
    intentHash,
    mode: shadow ? "shadow" : intent.network === "mainnet" ? "mainnet-wallet" : "testnet-wallet",
    method: "stx_callContract",
    params: shadow ? null : {
      contract: call.contract,
      functionName: call.function,
      functionArgs: call.args,
      network: intent.network,
      postConditions: call.postConditions,
      postConditionMode: "deny",
    },
    expiresAt: intent.expiresAt,
    warnings: shadow ? ["Shadow mode: this verified intent cannot be sent to a wallet or broadcast"] : intent.warnings,
  };
}
