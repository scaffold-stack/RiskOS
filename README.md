# RiskOS

RiskOS is a non-custodial, evidence-backed risk and protective-action layer for Bitcoin finance on Stacks. This repository implements the MVP boundaries in the supplied `Stacks_Bitcoin_RiskOS_Technical_Implementation_Blueprint.pdf`.

## Implemented vertical slice

- Normalized lending and concentrated-liquidity position contracts
- Provenance and confidence on every position
- Deterministic lending health and LP liquidity findings
- Fixed-point monetary calculations without JavaScript floating point
- Expiring, allowlisted, simulated testnet repayment intents
- Fastify API and responsive React address-inspection UI
- Safe live Stacks balance adapter that marks unknown token metadata unsupported
- Unit, API integration, and Chromium E2E tests
- Production fixture lockout and initial Fly.io/Cloudflare deployment artifacts
- PostgreSQL canonical block/event ledger with idempotent Chainhook ingestion
- Reorg rollback with dependent snapshot invalidation
- Ed25519-signed, versioned integration registry
- Current Hiro v3 principal balances and v2 block reconciliation
- On-chain verified sBTC, Zest v2, Bitflow, Hermetica, and Granite mainnet registry candidate
- Registry-gated Zest pinned-tip reads and Bitflow LP shadow reads
- Reorg-aware Zest/Bitflow ownership and sBTC lifecycle projections
- Canonical index-block-hash position snapshots and a strict 100-address comparison gate
- Evidence-freshness and missing-price risk findings with explainable inputs and deterministic scenarios
- Wallet-owned, persisted alert rules with deduplicated evidence occurrences
- One-time domain-bound Stacks signature challenges and hashed, short-lived server sessions
- Official Stacks Connect wallet discovery, signing, disconnect, and session restoration in the web app
- Integrity-hashed protective intents with expiry, state-drift, simulation, and ownership checks
- Testnet wallet-request/submission tracking and mandatory non-executable mainnet shadow mode
- Registry-verified Zest v0.8 repayment construction with real Clarity arguments and an FT spend-cap post-condition
- Meaning-first portfolio summary (`/v1/address/{address}/portfolio`) answering the central capital question
- Risk findings always include plain-language meaning, why-it-matters, if-you-do-nothing, and explained metrics
- Overview / Positions / Risk / Protect / Bridge UI with Stacks brand colors (`#fc6432`, `#5546FF`, `#131416`)
- Allocation donut, protocol bars, deployed-vs-idle split, LP range, liquidation distance, and protect before/after views
- Fixture wallet idle + locked balances so deployed/idle/locked capital is demonstrable
- Mainnet live reads with DIA plus Pyth/CoinGecko price-source agreement for positions, risk, and portfolio
- Hermetica sUSDh valuation from the pinned USDh-per-sUSDh contract rate and independently bounded USDh/USD market evidence
- Granite gUSDC valuation from pinned share-to-aeUSDC conversion, plus direct borrower collateral/debt-share discovery
- Candidate registry bootstrap for local live mode (production still requires signed activation)
- Advisory-only mainnet protect (shadow intents; broadcast disabled)
- `@riskos/client` SDK and embeddable `RiskOsWidget` with Integrations preview page
- Ed25519 dual-reviewed registry signing/activation (`registry:keygen|sign|activate`) with `REGISTRY_SIGNED_PATH` boot
- Live pricing uses a 2-of-3 DIA/Pyth/fixed-ID CoinGecko quorum and fails closed without two agreeing sources; no silent static-price fallback
- 100-address comparison gate + artifact (`npm run gate:100-addresses`)
- Zest multi-asset legs + Bitflow Hiro NFT ownership reconcile
- Docker Compose Postgres + Chainhook Hiro backfill script

## Run locally

```sh
cp .env.example .env
# set REGISTRY_TRUSTED_KEY_FINGERPRINTS to the fingerprint from registry:keygen / docs/signed-registry-milestone.md
npm install
npm run dev
```

Open `http://localhost:5173` and use the prefilled demo address. Public inspection needs no wallet. Saving alerts and requesting protective actions require a wallet ownership signature.

Integrity checks:

```sh
npm run gate:100-addresses
npm run test:mainnet-shadow
```

## Verify

```sh
npm run typecheck
npm test
npm run test:e2e
npm run test:postgres
npm run registry:verify -- registry/mainnet/2026-09-04.2.candidate.json
npm run test:mainnet-shadow
RISKOS_CANDIDATE_URL=https://candidate.example \
RISKOS_REFERENCE_URL=https://independent-reference.example \
npm run gate:100-addresses -- addresses.json artifacts/mainnet-100-address-comparison.json
npm run gate:risk-cases -- historical-risk-cases.json artifacts/risk-validation.json
npm run build
```

## Safety status

Fixture mode is intentionally testnet-only. Mainnet reads prefer an Ed25519-signed dual-reviewed registry (`REGISTRY_SIGNED_PATH`). Unsigned candidates remain a non-production fallback. Mainnet action workflows stay non-executable shadow intents until the signed registry contains reviewed transaction functions, the 100-address gate passes, and the mandated shadow/security gates complete. See [signed registry milestone](docs/signed-registry-milestone.md) and [mainnet protocol data](docs/mainnet-protocol-data.md).

See [the data-foundation guide](docs/data-foundation.md) for ingestion, registry, reconciliation, and PostgreSQL operations.
See [the mainnet work order](docs/mainnet-work-order.md) for the Zest shadow scope and the gates that still prevent broadcast.
