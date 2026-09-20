export type RiskSeverity = "info" | "low" | "medium" | "high" | "critical";
export type RiskCategory = "liquidation" | "liquidity" | "oracle" | "bridge" | "unsupported";
export type ConfidenceState = "verified" | "estimated" | "degraded" | "unsupported";

export interface Provenance {
  source: "chainhook" | "contract-read" | "stacks-api" | "bitcoin-rpc" | "oracle" | "quote" | "fixture";
  blockHeight?: number;
  transactionId?: string;
  observedAt: string;
}

export interface Confidence {
  state: ConfidenceState;
  score: number;
  reasons: string[];
}

export interface AssetAmount {
  asset: string;
  amountAtomic: string;
  decimals: number;
  valueUsd: string | null;
  protocolAssetId?: number;
  contractPrincipal?: string;
  assetIdentifier?: string;
  valuation?: {
    priceUsd: string;
    source: string;
    observedAt: string;
    ageSeconds: number | null;
    confidence: number;
    meaning: string;
  };
}

export interface EarningsEvidence {
  annualizedRateBps: number | null;
  rateKind: "supply-apr" | "provider-apy" | "realized-apy";
  earnedToDateUsd: string | null;
  observedAtBlock: number | null;
  meaning: string;
  provenance: Provenance[];
  confidence: Confidence;
}

export interface WalletPosition {
  id: string;
  type: "wallet";
  protocol: { id: "stacks"; version: string };
  asset: AssetAmount;
  spendable: boolean;
  provenance: Provenance[];
  confidence: Confidence;
}

export interface LendingPosition {
  id: string;
  type: "lending";
  protocol: { id: string; version: string; contract: string };
  collateral: AssetAmount;
  debt: AssetAmount;
  legs?: { collateral: AssetAmount[]; debt: AssetAmount[] };
  parameters: { liquidationThresholdBps: number; maximumLtvBps: number };
  rates?: {
    borrowAprBps: number;
    supplyAprBps: number;
    utilizationBps: number;
    reserveFactorBps: number;
    observedAtBlock: number;
    debtProjections: Array<{ days: 7 | 30 | 90; amountAtomic: string; assumption: string }>;
  };
  provenance: Provenance[];
  confidence: Confidence;
}

export interface SupplyPosition {
  id: string;
  type: "supply";
  protocol: { id: string; version: string; contract: string };
  asset: AssetAmount;
  rates?: {
    supplyAprBps: number;
    utilizationBps: number;
    reserveFactorBps: number;
    observedAtBlock: number;
  };
  earnings?: EarningsEvidence;
  provenance: Provenance[];
  confidence: Confidence;
}

export interface LiquidityPosition {
  id: string;
  type: "liquidity";
  protocol: { id: string; version: string; contract: string };
  token0: AssetAmount;
  token1: AssetAmount;
  lowerPrice: string;
  upperPrice: string;
  currentPrice: string;
  exitSlippageBps: number | null;
  earnings?: EarningsEvidence;
  provenance: Provenance[];
  confidence: Confidence;
}

export type Position = WalletPosition | LendingPosition | SupplyPosition | LiquidityPosition;

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

export interface RiskFinding {
  riskId: string;
  positionId: string;
  severity: RiskSeverity;
  category: RiskCategory;
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
  confidence: Confidence;
  expiresAt: string;
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
  verifiedSubtotalUsd: string | null;
  verifiedSubtotalPositionCount: number;
  valuedSubtotalUsd: string | null;
  valuedSubtotalPositionCount: number;
  valuedAssetsSubtotalUsd: string | null;
  valuedDebtSubtotalUsd: string | null;
  valuedDeployedSubtotalUsd: string | null;
  valuedIdleSubtotalUsd: string | null;
  valuedLockedSubtotalUsd: string | null;
  valuedBtcExposureSubtotalUsd: string | null;
  valuedNetVsBtcExposureUsd: string | null;
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
      severity: RiskSeverity;
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
    scope: "complete-portfolio" | "valued-subset";
    excludedPositionCount: number;
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

export interface AlertRule {
  ruleId: string;
  address: string;
  name: string;
  categories: RiskCategory[];
  minimumSeverity: RiskSeverity;
  enabled: boolean;
  cooldownSeconds: number;
  createdAt: string;
}

export interface AlertOccurrence {
  occurrenceId: string;
  ruleId: string;
  address: string;
  riskId: string;
  severity: RiskSeverity;
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

export interface WalletSession {
  address: string;
  expiresAt: string;
  token?: string;
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

export interface YieldMarket {
  id: string;
  protocol: string;
  kind: "lending" | "liquidity" | "stacking";
  assets: string;
  annualizedRateBps: number | null;
  rateLabel: "Supply APR" | "Fee APR" | "Reward APY";
  evidenceState: "verified" | "provider-reported" | "unavailable";
  confidenceScore: number;
  observedAtBlock: number | null;
  observedAt: string;
  tvlUsd: string | null;
  independentRateEvidence: {
    source: string;
    observedAt: string;
    annualizedRateBps: number;
    differenceBps: number;
  } | null;
  capacityEvidence: { source: string; observedAt: string; tvlUsd: string } | null;
  source: string;
  meaning: string;
  eligibleForAllocation: boolean;
  allocationExclusionReason?: string | null;
}

export interface YieldStrategy {
  id: string;
  marketId: string;
  protocol: string;
  kind: YieldMarket["kind"];
  assets: string;
  annualizedRateBps: number | null;
  rateLabel: YieldMarket["rateLabel"];
  evidenceState: YieldMarket["evidenceState"];
  confidenceScore: number;
  modes: Array<"explore" | "recommend">;
  eligibleForRecommendation: boolean;
  exclusionReason: string | null;
  tvlUsd: string | null;
  capacityEvidence: YieldMarket["capacityEvidence"];
  observedAt: string;
  source: string;
  meaning: string;
}

export interface YieldAllocationPlan {
  capitalUsd: string;
  days: 30 | 90 | 365;
  mode: "explore" | "recommend";
  allocatedUsd: string;
  unallocatedUsd: string;
  projectedGrossEarningsUsd: string;
  weightedAnnualizedRateBps: number;
  generatedAt: string;
  evidenceAsOf: string | null;
  allocations: Array<{
    marketId: string;
    protocol: string;
    kind: YieldMarket["kind"];
    assets: string;
    amountUsd: string;
    shareBps: number;
    annualizedRateBps: number;
    rateLabel: YieldMarket["rateLabel"];
    projectedGrossEarningsUsd: string;
    evidenceState: YieldMarket["evidenceState"];
    confidenceScore: number;
    observedAt: string;
    observedAtBlock: number | null;
    reportedTvlUsd: string | null;
    reportedTvlCapacityUsd: string | null;
    source: string;
    independentRateEvidence: YieldMarket["independentRateEvidence"];
    capacityEvidence: YieldMarket["capacityEvidence"];
  }>;
  markets: YieldMarket[];
  policy: {
    objective: string;
    maximumProtocolShareBps: number;
    maximumMarketShareBps: number;
    maximumPoolTvlShareBps: number;
  };
  warnings: string[];
}

export interface PortfolioHistory {
  address: string;
  observations: Array<{
    indexBlockHash: string;
    blockHeight: number;
    observedAt: string;
    registryVersion: string;
    positions: Position[];
    valuedNetSubtotalUsd: string | null;
    valuedAssetsSubtotalUsd: string | null;
    valuedDebtSubtotalUsd: string | null;
    valuedPositionCount: number;
    excludedPositionCount: number;
    complete: boolean;
  }>;
  cashFlows: Array<{
    protocol: "zest" | "bitflow";
    kind: string;
    blockHeight: number;
    indexBlockHash: string;
    transactionId: string;
    positionKey: string;
    amounts: Record<string, unknown>;
  }>;
  integrity: {
    canonicalOnly: true;
    reorgInvalidatedSnapshotsExcluded: true;
    state: "observations-available" | "baseline-only" | "no-baseline";
  };
  earnedYield: {
    valueUsd: null;
    state: "attribution-required" | "cash-flow-history-required";
    meaning: string;
  };
}

export interface SbtcOperation {
  operationKey: string;
  direction: "deposit" | "withdrawal";
  state:
    | "requested"
    | "signer-accepted"
    | "bitcoin-confirming"
    | "stacks-completed-bitcoin-unverified"
    | "completed"
    | "failed"
    | "evidence-conflict";
  canonical: boolean;
  reasons: string[];
  bitcoin: Array<{ txid: string; confirmations: number; confirmed: boolean }>;
}

export interface HealthResponse {
  status: string;
  dataMode: "fixture" | "live";
  network?: "mainnet" | "testnet";
  registryMode?: "signed" | "candidate" | "none";
  execution: string;
  pricing?: string;
  modules?: Record<string, string>;
  time?: string;
}

export type CommercialPlanId = "free" | "pro" | "treasury" | "developer" | "protocol";
export type CommercialFeature =
  | "public-read"
  | "yield-explore"
  | "yield-recommend"
  | "history-extended"
  | "alerts-unlimited"
  | "reports"
  | "teams"
  | "api-access"
  | "priority-support";

export interface CommercialPlan {
  id: CommercialPlanId;
  name: string;
  audience: string;
  priceUsdMonthly: number | null;
  apiRequestsMonthly: number;
  maxAlertRules: number;
  maxWallets: number;
  features: CommercialFeature[];
  highlights: string[];
}

export interface PlansResponse {
  currency: "USD";
  billingState: "manual-provisioning";
  plans: CommercialPlan[];
  executionFeesEnabled: false;
}

export interface ApiUsage {
  keyId: string;
  periodStart: string;
  requestCount: number;
  monthlyRequestLimit: number;
  remaining: number;
}

export interface DeveloperUsageResponse {
  key: PublicApiKey;
  usage: ApiUsage;
}

export interface PublicApiKey {
  keyId: string;
  keyPrefix: string;
  ownerAddress: string | null;
  name: string;
  plan: CommercialPlanId;
  status: "active" | "revoked";
  monthlyRequestLimit: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AccountPlanResponse {
  entitlement: {
    subjectType: "wallet";
    subjectId: string;
    plan: "free" | "pro" | "treasury" | "developer" | "protocol";
    status: "active" | "expired" | "revoked";
    source: "manual" | "billing";
    startsAt: string;
    endsAt: string | null;
    updatedAt: string;
  } | null;
  plan: CommercialPlan;
}

export interface AccountApiKeysResponse extends AccountPlanResponse {
  canCreate: boolean;
  maximumActiveKeys: number;
  keys: Array<{ key: PublicApiKey; usage: ApiUsage }>;
}

export interface CreatedApiKeyResponse {
  apiKey: string;
  key: PublicApiKey;
}

export interface PortfolioEvidenceReport {
  schemaVersion: "riskos.report.v1";
  generatedAt: string;
  address: string;
  plan: "pro" | "treasury" | "protocol";
  portfolio: PortfolioSummary;
  positions: PositionEnvelope;
  risks: RiskFinding[];
  integrity: {
    walletOwnershipAuthenticated: true;
    currentEvidenceOnly: true;
    advisoryOnly: boolean;
    meaning: string;
  };
}
