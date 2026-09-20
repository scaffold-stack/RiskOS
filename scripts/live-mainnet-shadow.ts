import { readFile } from "node:fs/promises";
import { BitflowMainnetAdapter, discoverZestVerifiedAssets, StacksApiAdapter, StacksReadOnlyClient, ZestMainnetAdapter } from "../packages/adapters/src/index.js";
import { registryManifestSchema } from "../packages/data-foundation/src/registry.js";
import { evaluateRisks } from "../packages/risk-engine/src/index.js";
import { analyzePortfolio } from "../packages/portfolio-engine/src/index.js";
import { planZestMainnetRepay } from "../packages/execution/src/index.js";
import { BitflowMarketPriceBook, DiaOraclePriceBook, enrichPositionsWithUsd, StackingDaoExchangeRatePriceBook, ZestVaultExchangeRatePriceBook } from "../packages/pricing/src/index.js";

const manifest = registryManifestSchema.parse(JSON.parse(await readFile(
  new URL("../registry/mainnet/2026-09-04.2.candidate.json", import.meta.url), "utf8",
)));
const provider = async () => manifest;
const stacksUrl = process.env.STACKS_API_URL ?? "https://api.hiro.so";
const zestAddress = process.env.ZEST_SHADOW_ADDRESS ?? "SP288D9CSDS3C10Z5C5J0R2ZE51HKZ35W4XWXKW7H";
const bitflowAddress = process.env.BITFLOW_SHADOW_ADDRESS ?? "SP1BXRXA0Z67MB6G31FP1R52ZX5GQTZ5008KZG77A";
const client = new StacksReadOnlyClient(stacksUrl, fetch, process.env.HIRO_API_KEY);
const referenceClient = process.env.STACKS_REFERENCE_API_URL
  ? new StacksReadOnlyClient(
      process.env.STACKS_REFERENCE_API_URL,
      fetch,
      process.env.STACKS_REFERENCE_API_KEY,
    )
  : undefined;
const priceBook = new ZestVaultExchangeRatePriceBook(
  new StackingDaoExchangeRatePriceBook(
    new BitflowMarketPriceBook(new DiaOraclePriceBook(client), provider), client, provider,
  ),
  client,
  provider,
);
const verifiedAssets = async () => [
  ...manifest.entries.flatMap((entry) => entry.assetDefinitions),
  ...await discoverZestVerifiedAssets(provider, client),
];
const excludedWalletAssets = async () => manifest.entries
  .filter((entry) => entry.enabled && entry.protocol === "bitflow")
  .map((entry) => `${entry.contractPrincipal}::pool-token`);
const adapters = [
  { address: bitflowAddress, adapter: new StacksApiAdapter(stacksUrl, fetch, process.env.HIRO_API_KEY, verifiedAssets, excludedWalletAssets, referenceClient) },
  { address: zestAddress, adapter: new ZestMainnetAdapter(provider, client) },
  { address: bitflowAddress, adapter: new BitflowMainnetAdapter(
    provider,
    process.env.BITFLOW_APP_API_URL ?? "https://bff.bitflowapis.finance/api/app",
    process.env.BITFLOW_QUOTES_API_URL ?? "https://bff.bitflowapis.finance/api/quotes",
    fetch,
    stacksUrl,
    process.env.HIRO_API_KEY,
    referenceClient,
  ) },
];

const results = [];
let zestRepayShadow = null;
let portfolio = null;
for (const { address, adapter } of adapters) {
  const discovered = await adapter.discover(address);
  const { positions, warnings, quotes } = await enrichPositionsWithUsd(discovered, priceBook);
  const lending = positions.find((position) => position.type === "lending");
  if (adapter.id === "zest-v2" && lending?.type === "lending") {
    const risk = evaluateRisks([lending])[0]!;
    const stateBlock = lending.provenance[0]?.blockHeight ?? 0;
    const intent = planZestMainnetRepay(address, lending, risk, lending.debt.amountAtomic, stateBlock, manifest);
    zestRepayShadow = {
      status: intent.status, mode: intent.executionMode, registryVersion: intent.registryVersion,
      contract: intent.calls[0]?.contract ?? null, function: intent.calls[0]?.function ?? null,
      clarityArgumentCount: intent.calls[0]?.args.length ?? 0,
      postConditionCount: intent.calls[0]?.postConditions.length ?? 0,
      advisoryOnly: true,
    };
    portfolio = analyzePortfolio({
      address,
      asOf: { stacksBlockHeight: stateBlock, bitcoinBlockHeight: 0, observedAt: new Date().toISOString() },
      positions,
      warnings,
    }, evaluateRisks(positions));
  }
  results.push({
    adapter: adapter.id,
    address,
    count: positions.length,
    valuationWarnings: warnings,
    quotes: quotes.map((quote) => ({ asset: quote.asset, priceUsd: quote.priceUsd, source: quote.source, ageSeconds: quote.ageSeconds })),
    positions: positions.map((position) => ({
      id: position.id,
      type: position.type,
      contract: position.type === "wallet" ? null : position.protocol.contract,
      blockHeight: position.provenance[0]?.blockHeight ?? null,
      confidence: position.confidence.state,
      ...(position.type === "lending" ? {
        collateral: position.collateral.asset,
        debt: position.debt.asset,
        collateralUsd: position.collateral.valueUsd,
        debtUsd: position.debt.valueUsd,
        rates: position.rates ?? null,
      } : {}),
      ...(position.type === "liquidity" ? {
        token0Usd: position.token0.valueUsd,
        token1Usd: position.token1.valueUsd,
      } : {}),
      ...(position.type === "wallet" ? { assetUsd: position.asset.valueUsd } : {}),
    })),
  });
}
console.log(JSON.stringify({
  mode: "read-only-mainnet-modules",
  modules: { positions: true, risk: true, protect: "advisory-shadow", distribution: "sdk+widget" },
  transactionsEnabled: false,
  zestRepayShadow,
  portfolio: portfolio ? {
    headline: portfolio.headline,
    netWorthUsd: portfolio.netWorthUsd,
    risk: portfolio.risk.classification,
    safestAction: portfolio.centralAnswer.safestAction,
  } : null,
  results,
}, null, 2));
