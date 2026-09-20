# Production deployment and launch runbook

## Current release boundary

Production live mode exposes registry-gated reads, canonical protocol projection, deterministic risk, and wallet-owned alert storage. sBTC lifecycle and public risk/alert exposure remain release-gated until mainnet comparison/backfill has passed. Wallet authentication and the protected-intent state machine are implemented, but every mainnet intent remains non-executable shadow data until the transaction registry, comparison, shadow-period, and security gates pass. Fixture data and fixture transaction intents cannot start under `NODE_ENV=production`.

## Low-cost deployment

See **[deploy-free.md](./deploy-free.md)** for the free-tier path (Fly + Neon + Cloudflare Pages).

1. Deploy `apps/web` to Cloudflare Pages using `npm run build:web` and output directory `apps/web/dist`.
2. Put the web app and API on HTTPS origins under the same registrable domain when wallet cookies are required (for example `app.example.com` and `api.example.com`), replace the API host in `apps/web/public/_headers`, and set `VITE_API_URL` before building. The strict httpOnly wallet-session cookie intentionally will not cross unrelated `pages.dev` and `fly.dev` sites.
3. Use repo-root `fly.toml` (from `infra/fly/api.fly.toml.example`) and choose an app name and primary region.
4. Provision Neon free Postgres (or Fly Managed Postgres), attach it to the API, and set `WEB_ORIGIN`, distinct Chainhook/operations bearer tokens, and trusted registry-key fingerprints as secrets via `./scripts/fly-secrets-from-env.sh`.
5. Deploy the API with `fly deploy`; the release command applies versioned migrations.
6. Verify and dual-review the mainnet candidate, sign it with the external release key, activate it through the operations endpoint, and retain the signed artifact outside the image.
7. Configure `SBTC_EMILY_URL` and `BITCOIN_ESPLORA_URL`, then verify both dependency health and rate limits.
8. Run `npm run test:mainnet-shadow` and `npm run test:sbtc-mainnet`, verify
   `/health`, then query known public Zest and Bitflow addresses and confirm all
   unregistered contracts/tokens are visibly rejected or unsupported. The sBTC
   smoke test requires canonical Stacks ownership, Emily amount/fee/fulfillment,
   and confirmed Bitcoin deposit+sweep evidence to agree.
9. Run the 100-address gate against an independently calculated reference deployment. Preserve and review the zero-mismatch artifact before public beta.

## Projection backfill (production)

Projection history is required for cash-flow attribution and sBTC lifecycle evidence.

```sh
# Apply migrations (includes paused checkpoint status)
npm run db:migrate

# Estimate remaining Hiro event pages (optional)
npm run backfill:estimate

# Exhaust every projection-capable contract (Zest market/vaults, Bitflow DLMM, sBTC registry).
# Resumable: paused checkpoints continue from next_offset. Safe to re-run.
npm run backfill:registry-events:complete

# Or resume a subset:
BACKFILL_CONTRACTS=SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry \
BACKFILL_UNTIL_EXHAUSTED=1 BACKFILL_MAX_PAGES_PER_CONTRACT=400 \
  npm run backfill:registry-events

# Fail closed until every checkpoint is status=complete (not paused)
npm run audit:projections
```

Bitflow DLMM pools can exceed hundreds of thousands of Hiro events; expect a multi-hour
to multi-day resume loop. Zest vaults and the sBTC registry are typically smaller and
should be exhausted first.

## Before public beta of protocol positions

- Re-run two-source/on-chain verification for every candidate contract immediately before signing.
- Backfill canonical Zest/Bitflow/sBTC projections from each registered activation block and review all `projection_issues`.
- Use the resumable registry-event path until every projection-capable checkpoint
  is `status=complete` (exhausted Hiro pages), then require `npm run audit:projections`
  to pass. Prefer `npm run backfill:registry-events:complete`. A `paused` checkpoint
  is not production-ready. The recent block-range command is not sufficient launch evidence.
- Obtain protocol-approved golden addresses and expected outputs.
- Validate the signed-off fixture against the deployed candidate with
  `GOLDEN_ADDRESSES_PATH=... RISKOS_CANDIDATE_URL=... npm run gate:golden-addresses`.
  The fixture must name its approvers and include at least two evidence URLs;
  RiskOS intentionally provides no synthetic default fixture.
- Run historical replay, reorg, duplicate-event, stale-source, and dependency-outage tests.
- Add a second Stacks data source and reconciliation worker.

## Before enabling mainnet transaction intents

- Verify wallet challenge authentication against the supported production wallet matrix.
- Complete contract/function allowlists and post-condition templates.
- Compare simulation results against protocol read-only calls.
- Run a two-week shadow period where intents cannot be broadcast.
- Resolve all high/critical security findings.
- Add WAF/rate limiting, paging, backup restore testing, and a public incident contact.

## Implemented milestone controls

- Five-minute, domain/address/network-bound challenges are single-use; successful Stacks signatures create 30-minute sessions whose raw bearer token is never stored.
- Alerts and actions require an authenticated address match. Public address inspection remains login-free.
- Alert occurrences have deterministic identities per rule/risk pair, preventing duplicate notifications while evidence is updated.
- Transaction intents are hashed from the same typed object used for review and wallet-request construction.
- Wallet requests fail closed on tampering, failed simulation, expiry, missing calls, or canonical state drift.
- Mainnet wallet payloads and submission recording are rejected during shadow mode. Only the fixture/testnet E2E path can record a simulated confirmation.

## Rollback

If any source, adapter, registry, risk model, or transaction template becomes disputed, disable the affected adapter/action. Read responses must show a degraded or unsupported state; action construction must fail closed.
