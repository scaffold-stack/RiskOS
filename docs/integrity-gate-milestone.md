# Integrity + 100-address gate milestone

## Goal

Close live-mode valuation stubs, ship the executable 100-address comparison artifact path, add Chainhook/Postgres backfill ops, and harden Zest multi-asset + Bitflow NFT reconcile. **Protect remains advisory.**

## Stub fixes (pricing integrity)

- Live API uses **DIA + Pyth with fixed-ID CoinGecko fallback + deployed Zest vault conversions + Bitflow stablecoin markets** (no `StaticFallbackPriceBook`).
- Enrichment **refuses** `source: "fixture"` quotes.
- Portfolio `btcReferencePriceUsd` comes from DIA when available; otherwise `null` (never hardcoded `$100000`).
- `/health.pricing` identifies the configured quorum. Pyth is tried per feed;
  denied or unavailable feeds fall back to CoinGecko, but still require DIA
  agreement. Quotes fail closed if the selected reference or DIA is stale,
  malformed, unavailable, or exceeds `PRICE_MAX_DIVERGENCE_BPS`.

## 100-address gate

Address list: `fixtures/mainnet-100-addresses.json`.

```sh
# Local adapter self-consistency (engineering artifact)
npm run gate:100-addresses -- fixtures/mainnet-100-addresses.json artifacts/mainnet-100-address-comparison.json

# API vs direct adapters (requires running RiskOS API)
RISKOS_GATE_MODE=api-vs-adapters RISKOS_CANDIDATE_URL=http://127.0.0.1:3001 \
  npm run gate:100-addresses

# Grant-grade: two independent deployments
RISKOS_GATE_MODE=http \
RISKOS_CANDIDATE_URL=https://candidate.example \
RISKOS_REFERENCE_URL=https://reference.example \
  npm run gate:100-addresses
```

## Chainhook backfill

```sh
docker compose up -d postgres
# uncomment DATABASE_URL in .env
npm run db:migrate
# Historical protocol events from projection-capable registry contracts only
# (Zest market/vaults, Bitflow DLMM pools, sBTC registry). Token and read-only
# oracle contracts are excluded because they do not decode into protocol projections.
# The command checkpoints each contract and safely resumes on the next invocation.
# Production requires exhaustion of every contract event page — use:
#   npm run backfill:registry-events:complete
# Bounded runs leave checkpoints in status=paused until resumed.
npm run backfill:registry-events
npm run backfill:estimate

# Fail closed until every projection contract is status=complete (not paused),
# with zest/bitflow/sbtc projections present and zero canonical decode issues.
npm run audit:projections

# Small recent block-range diagnostic only; not the activation-history backfill.
BACKFILL_MAX_BLOCKS=20 npm run backfill:chainhook
```

For destructive PostgreSQL integration tests, use `npm run test:postgres:isolated`.
It creates a throwaway native PostgreSQL cluster named `riskos_integration`, runs
all migrations and tests, then stops and removes only that generated cluster.

## Protocol hardening

- **Zest**: all collateral/debt legs normalized into `legs`; primary repay leg remains first debt asset; HF uses summed USD after pricing.
- **Zest receipt valuation**: `z*` vault shares use pinned `get-underlying`,
  `get-decimals`, and `convert-to-assets` reads. Underlying LST confidence is
  still limited until its own registry-approved conversion or independent market
  price is available.
- **Bitflow**: Hiro NFT holdings for `pool-token-id` reconcile ownership; confidence upgrades to `verified` when NFTs are present.

## Protect

Unchanged: mainnet intents stay `executionMode: "shadow"` / `BROADCAST_DISABLED`.
