# Mainnet modules milestone (advisory protect)

## Goal

Make **mainnet** work for Modules 1, 2, and 4 while Module 3 stays **advisory** (shadow intents, no broadcast). Existing fixture/testnet protect flows remain intact.

## What shipped

### Module 1 — Unified Position API (mainnet reads)
- Live adapters for Stacks balances, Zest v2, and Bitflow remain registry-gated.
- `REGISTRY_SIGNED_PATH` boots an Ed25519 dual-reviewed release (`registryMode: signed`).
- `REGISTRY_CANDIDATE_PATH` remains a **non-production** fallback when no signed registry is active.
- Production still refuses candidate bootstraps.
- Multi-asset Zest positions degrade to the first collateral/debt pair instead of failing the whole address.
- Stacks wallet reads now attach tip block height when available.

### Module 2 — Risk engine (mainnet-valued)
- `packages/pricing` uses DIA (`BTC/USD`, `STX/USD`), optional authenticated
  Pyth consensus, a stablecoin peg risk model, and no fixture fallback in live mode.
- Zest receipt tokens use the deployed vault's pinned `convert-to-assets` result.
  Underlying LSTs retain limited confidence until their own conversion source or
  independent market quote is registry-approved.
- Live position envelopes are USD-enriched before risk/portfolio analysis.
- Lending health, portfolio net worth, allocations, and BTC scenarios work on mainnet amounts + DIA prices.
- Zest lending responses include variable borrow APR, derived supply APR,
  utilization, reserve factor, and 7/30/90-day debt projections. All are pinned
  to the same Stacks tip and explicitly assume the current variable rate remains
  unchanged; they are not advertised-yield placeholders.

### Module 3 — Protect (advisory only)
- Fixture/testnet repay + wallet signing **unchanged**.
- Mainnet intents remain `executionMode: "shadow"`; submissions return `BROADCAST_DISABLED`.
- UI explicitly labels Protect as advisory on mainnet/shadow.

### Module 4 — Distribution SDK / widget
- `packages/client` — typed `RiskOsClient` for health/positions/risk/portfolio/planRepay.
- `packages/widget` — embeddable `RiskOsWidget` (severity, capital at risk, one explanation, Protect CTA).
- Web **Integrations** page previews the widget and SDK snippet.

## Local live mode

```sh
cp .env.example .env
# set:
# DATA_MODE=live
# REGISTRY_CANDIDATE_PATH=registry/mainnet/2026-09-04.2.candidate.json
npm run dev
```

Smoke against public mainnet:

```sh
npm run test:mainnet-shadow
```

## Still deferred
- Production HSM/offline release key (local/dev key is checked in as public-only)
- Grant-grade 100-address comparison against a **second independent deployment** (local/self-consistency and api-vs-adapters gates ship now)
- Full Bitflow on-chain liquidity map amounts (NFT ownership reconcile ships; BFF quantities remain until map reads)
- Mainnet broadcast / wallet execution
- Rewards, Granite, stBTC, Bonds
