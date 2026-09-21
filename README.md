# RiskOSfolio

RiskOSfolio is a non-custodial Bitcoin capital intelligence, risk, and protective-planning platform for Stacks. It turns fragmented wallet and protocol evidence into normalized positions, explainable risk findings, evidenced yield strategies, alerts, reports, and developer APIs.

The product is designed around one operating rule: **observe first, preserve the evidence, and never imply that RiskOS controls user funds**. Public address inspection does not require a wallet. Ownership-sensitive features require a signed Stacks wallet challenge. Mainnet protective actions remain advisory and non-executable.

## Live product

| Surface          | Production URL                                      | Purpose                                                                |
| ---------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| Web application  | https://riskosfolio.pages.dev                       | Portfolio, risk, yield, alerts, reports, plans, and developer console  |
| API              | https://riskosfolio-api.fly.dev                     | Versioned public, wallet-authenticated, and metered endpoints          |
| Health           | https://riskosfolio-api.fly.dev/health              | Runtime mode, registry state, pricing boundary, and execution boundary |
| Admin monitoring | https://riskosfolio.pages.dev/admin                  | Password-protected adoption, API, chain, backfill, database, and deployment telemetry |
| Plans            | https://riskosfolio-api.fly.dev/v1/plans            | Current plan capabilities and enforceable quotas                       |
| Yield strategies | https://riskosfolio-api.fly.dev/v1/yield/strategies | Evidence-derived strategy catalog                                      |

Production currently uses live mainnet reads, an Ed25519-signed integration registry, Neon Postgres, Fly.io for the API, and Cloudflare Pages for the web application.

## What RiskOSfolio provides

### Portfolio intelligence

RiskOSfolio discovers an address across supported Stacks and Bitcoin-finance integrations, normalizes the resulting balances and protocol positions, and presents:

- wallet balances, including free and locked capital;
- collateral, debt, supplied assets, and liquidity positions;
- protocol and asset concentration;
- valued assets, valued debt, and net valued subtotal;
- deployed, idle, and locked capital boundaries;
- unsupported or unpriced positions without silently forcing them into totals;
- provenance, confidence, observation height, and freshness for each position.

The product deliberately distinguishes a valued subtotal from a complete net worth. Missing prices and unsupported assets remain visible rather than being coerced into zero.

### Deterministic risk engine

Risk findings are derived from normalized evidence and versioned logic. Current categories include:

- lending health and liquidation distance;
- concentrated-liquidity range and exit-liquidity conditions;
- oracle availability and independent price-source agreement;
- bridge and sBTC lifecycle state;
- stale evidence and unsupported exposure;
- protocol and contract integration boundaries.

Each finding includes:

- severity and category;
- plain-language meaning;
- why the finding matters;
- what may happen if no action is taken;
- the inputs and metric meaning behind the result;
- provenance and confidence.

### Protective planning

RiskOSfolio can prepare repayment plans for eligible debt positions. Protection is non-custodial and policy constrained:

- public preflight before wallet ownership is requested;
- wallet ownership required before an intent is persisted;
- allowlisted registry contract and function checks;
- intent hashing, expiry, and state-drift controls;
- simulation and target-health checks;
- fee caps and deny-mode post-conditions;
- testnet wallet request and submission tracking;
- mandatory advisory-shadow behavior on mainnet.

RiskOSfolio does not hold keys, sign for users, or broadcast mainnet protective transactions.

### Yield markets and strategies

The yield system exposes both raw market evidence and strategy-oriented records:

- `GET /v1/yield/markets` returns the allowlisted market universe;
- `GET /v1/yield/strategies` returns evidence-derived strategy records and their available modes;
- `POST /v1/yield/allocations` simulates or recommends a hypothetical capital split.

Two allocation modes are intentionally distinct:

- **Explore** keeps rates and evidence visible for research and may include clearly labeled provider-reported observations.
- **Recommend** fails closed and requires the stronger evidence and capacity conditions enforced by the strategy engine.

Rates, capacity, and projected earnings are never invented. A zero, missing, stale, or ineligible market remains visible with an exclusion reason.

### Alerts

Wallet owners can create persistent alert policies for selected risk categories and minimum severities. RiskOSfolio stores:

- wallet-owned rules;
- deduplicated occurrences;
- current state and evidence;
- occurrence history;
- plan-enforced rule limits.

### Evidence reports

Eligible wallet plans can generate a current portfolio evidence report containing normalized positions, portfolio totals, risk findings, provenance, confidence, and explicit integrity statements. Reports are evidence artifacts, not audits, guarantees, or transaction authorizations.

### Developer platform

The developer platform includes:

- a typed TypeScript client with 28 methods;
- an OpenAPI contract;
- public read endpoints;
- wallet-owned browser sessions;
- metered API keys and UTC-month usage;
- a live read-only API explorer;
- API-key creation, listing, quota display, and revocation;
- an embeddable React risk widget;
- structured errors, request IDs, timeouts, cancellation, and bounded GET retries.

The SDK source is maintained in `packages/client` as `@riskos/client` version `0.4.0`. It is production-built and used by this repository, but it has **not yet been published to the public npm registry**.

## User journeys

### 1. Public Bitcoin-finance user

Goal: understand an address without connecting a wallet.

1. Open the application.
2. Paste a Stacks address.
3. RiskOSfolio discovers current supported positions.
4. Review capital allocation, positions, confidence, and excluded evidence.
5. Open Risk to understand material failure modes.
6. Open Protect → Explore earning strategies to compare current markets.
7. Connect a wallet only when saving an alert, requesting a report, managing API credentials, or persisting a protective intent.

Public inspection never requires a signature and never requests a seed phrase.

### 2. Active Bitcoin-finance user

Goal: monitor risk and evaluate safer next steps.

1. Inspect the address and review the Overview.
2. Open Positions to understand collateral, debt, supply, liquidity, and free wallet balances.
3. Open Risk to prioritize findings by severity and meaning.
4. Connect the wallet using a domain-bound ownership message.
5. Create alert rules for relevant risk categories.
6. Compare evidenced yield strategies in Explore mode.
7. Preview a debt-repayment plan where a supported position exists.
8. Review simulation, expiry, state freshness, post-conditions, and warnings before any wallet action.

On mainnet, protection remains advisory even after wallet verification.

### 3. Treasury or DAO operator

Goal: establish a repeatable portfolio and risk review.

1. Inspect the treasury address.
2. Review deployed, idle, and locked capital.
3. Identify protocol, asset, and debt concentration.
4. Review liquidation, liquidity, oracle, bridge, and integration findings.
5. Connect the owner wallet and configure material alert policies.
6. Generate a current evidence report under an eligible plan.
7. Compare current earning strategies and recommendation eligibility.
8. Preserve the report and source timestamps for internal review.
9. Re-run the workflow after material portfolio or protocol changes.

RiskOSfolio does not represent evidence reports as financial audits or promise that observed yields will persist.

### 4. Application developer

Goal: integrate Bitcoin portfolio, risk, yield, or protection intelligence.

1. Open Developers → API explorer.
2. Test public endpoints against a real address.
3. Connect the wallet that owns the product plan.
4. Create an API key in Developers → API access.
5. Copy the secret immediately; only its hash is stored.
6. Build `packages/client` or consume the API/OpenAPI contract directly.
7. Keep API keys on a server, never in browser JavaScript.
8. Use wallet challenge sessions for owner-controlled browser workflows.
9. Monitor monthly usage and rotate or revoke keys from the Developer Console.
10. Treat mainnet protection responses as advisory.

Free wallets may create one active API key with 1,000 requests per UTC month. API Growth and Protocol Partner wallets may keep up to five active keys.

### 5. Protocol integration team

Goal: make protocol exposure observable and safe for downstream users.

1. Define exact contracts, assets, functions, and deployment metadata.
2. Add or update the candidate integration registry.
3. Implement pinned-tip read adapters.
4. Validate normalized positions against independent references.
5. Add golden-address and reconciliation fixtures.
6. Run the 100-address comparison gate and risk-case validation.
7. Complete registry review and signing.
8. Activate the signed registry version.
9. Reproject persisted canonical events.
10. Monitor discovery, pricing, evidence freshness, and incident behavior.

Sponsored or commercial relationships must not change risk scores, evidence eligibility, or yield ranking.

### 6. RiskOS operator

Goal: keep the production evidence system healthy.

1. Verify registry signatures and trusted fingerprints.
2. Apply database migrations.
3. Monitor Chainhook ingestion and canonical block progression.
4. Resume or audit protocol backfills when required.
5. Reproject facts from persisted canonical events after registry changes.
6. Run address-comparison and independent risk validation gates.
7. Verify price-source agreement and stale-evidence behavior.
8. Check production health, plans, strategies, and protected endpoints after deployment.
9. Preserve advisory-only mainnet execution until all execution gates are independently reviewed.

The unlinked `/admin` route is protected by a salted server-side scrypt
verifier and a short-lived tab session. It combines unique address searches,
request/error/latency analytics, wallet and API-key activity, Chainhook state,
canonical database counts, backfill checkpoints, registry state, deployment
metadata, and recent privacy-preserving activity. Analytics begin when migration
`009_admin_analytics.sql` is deployed; searches made before that point cannot be
reconstructed.

## Developer journey

### SDK workspace setup

```sh
npm install
npm run build:sdk
```

The generated package artifacts are written under `packages/client/dist`.

Example server-side usage:

```ts
import { RiskOsClient } from "@riskos/client";

const riskos = new RiskOsClient({
  baseUrl: "https://riskosfolio-api.fly.dev",
  apiKey: process.env.RISKOS_API_KEY,
  timeoutMs: 10_000,
  retries: 2,
});

const overview = await riskos.getOverview("SP...");
const strategies = await riskos.getYieldStrategies();
```

Key reliability behavior:

- transient GET failures use bounded retries;
- state-changing POST requests are not retried automatically;
- every request supports cancellation and a timeout;
- structured errors expose status, code, detail, request ID, and retry delay;
- monetary amounts are decimal strings rather than JavaScript floating-point numbers;
- address and path inputs are encoded;
- paid API keys use `x-api-key`;
- wallet ownership uses a short-lived bearer session or same-site httpOnly cookie.

### Browser wallet sessions

Browser clients should:

1. request `/v1/auth/challenge`;
2. ask the supported Stacks wallet to sign the returned ownership message;
3. submit the proof to `/v1/auth/verify`;
4. use the returned short-lived session for wallet-owned endpoints;
5. clear the session on expiry, rejection, or logout.

The production web application stores the short-lived cross-origin bearer session in tab-scoped `sessionStorage`, not `localStorage`. A custom same-registrable domain permits the preferred httpOnly-cookie flow.

### API key lifecycle

1. Wallet ownership is verified.
2. The effective plan determines quota and active-key count.
3. A 256-bit random API key is generated.
4. The plaintext secret is shown once.
5. Only its SHA-256 hash and safe prefix are stored.
6. Usage is incremented atomically per UTC month.
7. Revoked, unknown, and exhausted keys fail closed.

### Selected endpoint groups

| Group              | Endpoints                                                                |
| ------------------ | ------------------------------------------------------------------------ |
| Health and product | `/health`, `/v1/plans`, `/v1/demo`                                       |
| Portfolio          | `/v1/address/{address}/overview`, `/positions`, `/portfolio`, `/history` |
| Risk               | `/v1/address/{address}/risk`, `/v1/reports/portfolio`                    |
| Yield              | `/v1/yield/markets`, `/v1/yield/strategies`, `/v1/yield/allocations`     |
| Authentication     | `/v1/auth/challenge`, `/verify`, `/session`, `/logout`                   |
| Alerts             | `/v1/alerts`, `/v1/alerts/rules`                                         |
| Protect            | `/v1/actions/plan`, `/intents`, wallet request, and submission routes    |
| Developer account  | `/v1/account/plan`, `/v1/account/api-keys`, `/v1/developer/usage`        |
| Operations         | registry, entitlement, API provisioning, ingestion, and snapshot routes  |

See `openapi/riskos.v1.yaml` for the complete contract.

## Supported evidence and integrations

The signed mainnet registry and current adapters cover evidence paths for:

- sBTC lifecycle and balances;
- Zest lending and supply positions;
- Bitflow liquidity positions and market observations;
- Hermetica sUSDh evidence;
- Granite collateral and borrower evidence;
- StackingDAO earning rates;
- Hiro Stacks balances, blocks, transactions, and events;
- Bitcoin Esplora confirmation evidence;
- DIA, Pyth, CoinGecko, and Coinbase pricing boundaries;
- DefiLlama independent market observations where applicable.

Support is registry gated. A known symbol or external API response does not automatically make a contract trusted.

## Evidence architecture

```text
Stacks / Bitcoin / providers
            │
            ▼
  registry-gated adapters
            │
            ▼
 canonical event + block ledger
            │
            ├── protocol projections
            ├── current position snapshots
            └── canonical history
            │
            ▼
 normalized portfolio model
            │
            ├── risk engine
            ├── strategy engine
            ├── alerts and reports
            ├── API and SDK
            └── advisory protection planner
```

Core integrity properties:

- canonical index-block hashes bind snapshots;
- reorg rollback invalidates dependent projections;
- signed registries define trusted integration boundaries;
- fixed-point money logic avoids floating-point accounting errors;
- price-dependent conclusions require bounded source agreement;
- missing evidence degrades or blocks conclusions rather than creating defaults;
- every protective intent expires and is revalidated at the authenticated boundary.

## Plans and commercial boundaries

| Plan             | Intended user               | API-key boundary                    | Selected capabilities                                                |
| ---------------- | --------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Free             | Public users and evaluation | 1 key, 1,000 requests/month         | Current positions and risk, yield Explore, one alert rule            |
| Pro              | Active individual users     | 1 key, 10,000 requests/month        | Recommendation mode, extended history, reports, up to ten alerts     |
| Treasury         | Professional operators      | 1 key, 50,000 requests/month        | Expanded alerts, reports, extended history, priority support         |
| API Growth       | Applications and wallets    | Up to 5 keys, 50,000 requests/month | SDK/API capacity, recommendation mode, commercial integration rights |
| Protocol Partner | Integrated protocols        | Up to 5 keys, negotiated capacity   | Adapter work, monitored integration, protocol support                |

Billing provisioning remains manual until reviewed subscription and webhook handling is deployed. Credential management is self-service after wallet verification.

## Run locally

Requirements:

- Node.js 22 or newer for the repository;
- npm;
- PostgreSQL for persistence and integration tests;
- production provider credentials only when running live mode.

```sh
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`.

Important environment groups are documented in `.env.example`:

- runtime and network mode;
- Stacks and Bitcoin providers;
- database and Chainhook ingestion;
- signed registry path and trusted fingerprints;
- price-source URLs and tokens;
- web origins and wallet-session audience;
- operations authorization;
- anonymous API rate limits.

Do not commit `.env`.

## Verification

Core verification:

```sh
npm run typecheck
npm test
npm run build
```

PostgreSQL integration suite:

```sh
npm run test:postgres:isolated
```

Evidence and safety gates:

```sh
npm run registry:verify -- registry/mainnet/2026-09-13.1.signed.json
npm run gate:100-addresses
npm run gate:risk-cases -- historical-risk-cases.json artifacts/risk-validation.json
npm run test:mainnet-shadow
npm run test:sbtc-mainnet
```

Live evidence tools:

```sh
npm run evidence:address-cohort
npm run evidence:zest-history
npm run backfill:estimate
npm run audit:projections
```

## Deployment

The current low-cost production layout is:

- Neon Postgres;
- Fly.io API;
- Cloudflare Pages web application.

Detailed deployment instructions are in `docs/deploy-free.md`.

Typical release checks:

```sh
curl -fsS https://riskosfolio-api.fly.dev/health
curl -fsS https://riskosfolio-api.fly.dev/v1/plans
curl -fsS https://riskosfolio-api.fly.dev/v1/yield/strategies
```

Database migrations run through the Fly release command before the API machine update.

## Repository map

```text
apps/
  api/                    Fastify API, auth boundaries, and endpoint composition
  web/                    React/Vite product and marketing site
packages/
  adapters/               Protocol and provider discovery
  auth/                   Wallet ownership challenges and sessions
  client/                 Standalone TypeScript SDK
  commercial/             Plans, API keys, quotas, and entitlements
  data-foundation/        Registry, canonical events, projections, and reconciliation
  domain/                 Shared position, risk, money, and workflow contracts
  execution/              Protective intent integrity and wallet request construction
  portfolio-engine/       Capital totals, allocation, and portfolio meaning
  pricing/                Price evidence and source agreement
  risk-engine/            Deterministic risk findings and scenarios
  strategy-engine/        Yield allocation policy and evidence gates
  widget/                 Embeddable React risk widget
  workflows/              Alerts, sessions, intents, and persistence contracts
infra/
  postgres/migrations/    Ordered production schema migrations
openapi/                  Public API contract
registry/                 Candidate and signed integration registries
scripts/                  Operations, backfill, release, and evidence tooling
docs/                     Architecture, deployment, safety, and commercial guides
```

## Safety status

- Public mainnet reads are live.
- Production requires the signed registry.
- Unknown contracts and unsupported assets fail closed.
- Yield projections are hypothetical and evidence labeled.
- Evidence reports are not audits.
- Risk findings are not guarantees.
- RiskOSfolio does not custody funds or private keys.
- Mainnet protection is advisory-shadow-only.
- Testnet signing remains user controlled.

Further documentation:

- `docs/data-foundation.md`
- `docs/mainnet-protocol-data.md`
- `docs/mainnet-work-order.md`
- `docs/signed-registry-milestone.md`
- `docs/commercial-launch.md`
- `docs/deploy-free.md`
