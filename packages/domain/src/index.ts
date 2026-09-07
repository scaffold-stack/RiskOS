import { z } from "zod";

export const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");
export const stacksAddressSchema = z
  .string()
  .regex(/^(SP|SM|ST|SN)[A-Z0-9]{20,50}$/, "invalid Stacks address");

export const provenanceSchema = z.object({
  source: z.enum(["chainhook", "contract-read", "stacks-api", "bitcoin-rpc", "oracle", "quote", "fixture"]),
  blockHeight: z.number().int().nonnegative().optional(),
  transactionId: z.string().optional(),
  observedAt: z.string().datetime(),
});

export const confidenceSchema = z.object({
  state: z.enum(["verified", "estimated", "degraded", "unsupported"]),
  score: z.number().min(0).max(1),
  reasons: z.array(z.string()).default([]),
});

const assetAmountSchema = z.object({
  asset: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  decimals: z.number().int().nonnegative(),
  valueUsd: decimalStringSchema.nullable(),
  protocolAssetId: z.number().int().nonnegative().optional(),
  contractPrincipal: z.string().optional(),
  assetIdentifier: z.string().optional(),
});

const earningsEvidenceSchema = z.object({
  annualizedRateBps: z.number().int().nonnegative().nullable(),
  rateKind: z.enum(["supply-apr", "provider-apy"]),
  earnedToDateUsd: decimalStringSchema.nullable(),
  observedAtBlock: z.number().int().nonnegative(),
  meaning: z.string(),
});

export const walletPositionSchema = z.object({
  id: z.string(),
  type: z.literal("wallet"),
  protocol: z.object({ id: z.literal("stacks"), version: z.string() }),
  asset: assetAmountSchema,
  spendable: z.boolean(),
  provenance: z.array(provenanceSchema).min(1),
  confidence: confidenceSchema,
});

export const lendingPositionSchema = z.object({
  id: z.string(),
  type: z.literal("lending"),
  protocol: z.object({ id: z.string(), version: z.string(), contract: z.string() }),
  collateral: assetAmountSchema,
  debt: assetAmountSchema,
  /** Full multi-asset legs when the market holds more than one collateral/debt asset. */
  legs: z
    .object({
      collateral: z.array(assetAmountSchema).min(1),
      debt: z.array(assetAmountSchema).min(1),
    })
    .optional(),
  parameters: z.object({
    liquidationThresholdBps: z.number().int().min(1).max(10_000),
    maximumLtvBps: z.number().int().min(1).max(10_000),
  }),
  rates: z
    .object({
      borrowAprBps: z.number().int().nonnegative(),
      supplyAprBps: z.number().int().nonnegative(),
      utilizationBps: z.number().int().min(0).max(10_000),
      reserveFactorBps: z.number().int().min(0).max(10_000),
      observedAtBlock: z.number().int().nonnegative(),
      debtProjections: z
        .array(
          z.object({
            days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
            amountAtomic: z.string().regex(/^\d+$/),
            assumption: z.string(),
          }),
        )
        .length(3),
    })
    .optional(),
  provenance: z.array(provenanceSchema).min(1),
  confidence: confidenceSchema,
});

export const lendingSupplyPositionSchema = z.object({
  id: z.string(),
  type: z.literal("supply"),
  protocol: z.object({ id: z.string(), version: z.string(), contract: z.string() }),
  asset: assetAmountSchema,
  rates: z
    .object({
      supplyAprBps: z.number().int().nonnegative(),
      utilizationBps: z.number().int().min(0).max(10_000),
      reserveFactorBps: z.number().int().min(0).max(10_000),
      observedAtBlock: z.number().int().nonnegative(),
    })
    .optional(),
  earnings: earningsEvidenceSchema.optional(),
  provenance: z.array(provenanceSchema).min(1),
  confidence: confidenceSchema,
});

export const liquidityPositionSchema = z.object({
  id: z.string(),
  type: z.literal("liquidity"),
  protocol: z.object({ id: z.string(), version: z.string(), contract: z.string() }),
  token0: assetAmountSchema,
  token1: assetAmountSchema,
  lowerPrice: decimalStringSchema,
  upperPrice: decimalStringSchema,
  currentPrice: decimalStringSchema,
  exitSlippageBps: z.number().int().nonnegative().nullable(),
  earnings: earningsEvidenceSchema.optional(),
  provenance: z.array(provenanceSchema).min(1),
  confidence: confidenceSchema,
});

export const positionSchema = z.discriminatedUnion("type", [
  walletPositionSchema,
  lendingPositionSchema,
  lendingSupplyPositionSchema,
  liquidityPositionSchema,
]);

export type Position = z.infer<typeof positionSchema>;
export type LendingPosition = z.infer<typeof lendingPositionSchema>;
export type LendingSupplyPosition = z.infer<typeof lendingSupplyPositionSchema>;
export type LiquidityPosition = z.infer<typeof liquidityPositionSchema>;

export interface BlockReference {
  stacksBlockHeight: number;
  bitcoinBlockHeight: number;
  observedAt: string;
}

export interface PositionEnvelope {
  address: string;
  asOf: BlockReference;
  positions: Position[];
  warnings: string[];
}

export interface MetricMeaning {
  label: string;
  value: string;
  meaning: string;
}

export interface PortfolioSummary {
  address: string;
  asOf: BlockReference;
  displayCurrency: "USD" | "BTC";
  currency: "USD";
  headline: string;
  centralAnswer: {
    where: string;
    earning: string;
    canGoWrong: string;
    safestAction: string;
  };
  totalAssetsUsd: string | null;
  totalDebtUsd: string | null;
  netWorthUsd: string | null;
  deployedUsd: string | null;
  idleUsd: string | null;
  lockedOrPendingUsd: string | null;
  holdBtcComparisonUsd: string | null;
  holdBtcDeltaUsd: string | null;
  btcReferencePriceUsd: string | null;
  valuedPositionCount: number;
  missingValuationCount: number;
  metricMeanings: MetricMeaning[];
  risk: {
    score: number;
    previousScore: number | null;
    classification: "healthy" | "guarded" | "high-risk" | "critical";
    classificationMeaning: string;
    trend: "improving" | "stable" | "worsening" | "unknown";
    capitalAtRiskUsd: string | null;
    confidence: number;
    expectedScoreAfterAction: number | null;
    drivers: Array<{
      positionId: string;
      title: string;
      score: number;
      severity: RiskFinding["severity"];
      meaning: string;
      doNothing: string;
      recommendedAction: string | null;
    }>;
  };
  allocations: Array<{ key: string; valueUsd: string; percentageBps: number; meaning: string }>;
  protocols: Array<{ key: string; valueUsd: string; percentageBps: number; meaning: string }>;
  deployment: { deployedBps: number; idleBps: number; lockedBps: number; meaning: string };
  scenarios: Array<{
    name: string;
    shock: string;
    estimatedNetValueUsd: string | null;
    estimatedLossUsd: string | null;
    positionsAffected: number;
    explanation: string;
  }>;
  data: {
    state: "complete" | "partial" | "stale";
    lastUpdatedAt: string;
    stacksBlockHeight: number;
    bitcoinBlockHeight: number;
    sources: string[];
    warnings: string[];
  };
}

export interface RiskFinding {
  riskId: string;
  positionId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  category: "liquidation" | "liquidity" | "oracle" | "bridge" | "unsupported";
  score: number;
  title: string;
  meaning: string;
  whyItMatters: string;
  ifYouDoNothing: string;
  plainMetrics: MetricMeaning[];
  evidence: Array<{ metric: string; value: string; sourceBlock?: number }>;
  scenarios: Array<{ name: string; result: string; meaning?: string }>;
  recommendedActions: Array<{
    type: "repay" | "add-collateral" | "remove-liquidity";
    amount?: string;
    meaning?: string;
  }>;
  model: { id: string; version: string };
  confidence: z.infer<typeof confidenceSchema>;
  expiresAt: string;
}

export type AlertSeverity = RiskFinding["severity"];

export interface AlertRule {
  ruleId: string;
  address: string;
  name: string;
  categories: RiskFinding["category"][];
  minimumSeverity: AlertSeverity;
  enabled: boolean;
  cooldownSeconds: number;
  createdAt: string;
}

export interface AlertOccurrence {
  occurrenceId: string;
  ruleId: string;
  address: string;
  riskId: string;
  severity: AlertSeverity;
  title: string;
  evidence: RiskFinding["evidence"];
  state: "open" | "acknowledged" | "resolved";
  openedAt: string;
  updatedAt: string;
}

export interface WalletChallenge {
  challengeId: string;
  address: string;
  message: string;
  expiresAt: string;
}

export interface WalletSessionView {
  address: string;
  expiresAt: string;
}

export interface TransactionIntent {
  intentId: string;
  network: "mainnet" | "testnet";
  status: "blocked" | "ready";
  expiresAt: string;
  reason: { riskId: string; targetHealthFactor: string };
  calls: Array<{
    contract: string;
    function: string;
    args: string[];
    postConditions: Array<string | Record<string, string>>;
  }>;
  guardrails: {
    maximumStateAgeSeconds: number;
    maximumStateBlockDrift: number;
    maximumFeeMicroStx: string;
  };
  simulation: { status: "passed" | "blocked"; stateBlock: number; postHealthFactor: string | null };
  registryVersion: string;
  adapterVersion: string;
  warnings: string[];
  intentHash?: string;
  executionMode?: "shadow" | "testnet" | "mainnet";
  workflowState?: "planned" | "wallet-requested" | "submitted" | "confirmed" | "blocked";
}

export interface WalletTransactionRequest {
  intentId: string;
  intentHash: string;
  mode: "shadow" | "testnet-wallet" | "mainnet-wallet";
  method: "stx_callContract";
  params: {
    contract: string;
    functionName: string;
    functionArgs: string[];
    network: "mainnet" | "testnet";
    postConditions: Array<string | Record<string, string>>;
    postConditionMode: "deny";
  } | null;
  expiresAt: string;
  warnings: string[];
}

export interface ProtocolAdapter {
  readonly id: string;
  discover(address: string): Promise<Position[]>;
}
