# Production deployment and launch runbook

## Current release boundary

Production live mode exposes registry-gated reads, canonical protocol projection, deterministic risk, and wallet-owned alert storage. sBTC lifecycle and public risk/alert exposure remain release-gated until mainnet comparison/backfill has passed. Wallet authentication and the protected-intent state machine are implemented, but every mainnet intent remains non-executable shadow data until the transaction registry, comparison, shadow-period, and security gates pass. Fixture data and fixture transaction intents cannot start under `NODE_ENV=production`.

## Low-cost deployment

1. Deploy `apps/web` to Cloudflare Pages using `npm run build:web` and output directory `apps/web/dist`.
2. Put the web app and API on HTTPS origins under the same registrable domain (for example `app.example.com` and `api.example.com`), replace the example API domain in `apps/web/public/_headers`, and set `VITE_API_URL` before building. The strict httpOnly wallet-session cookie intentionally will not cross unrelated `pages.dev` and `fly.dev` sites.
3. Copy `infra/fly/api.fly.toml.example` to `fly.toml` and choose an app name and primary region.
4. Provision Managed Postgres, attach it to the API, and set `WEB_ORIGIN`, distinct Chainhook/operations bearer tokens, and trusted registry-key fingerprints as secrets.
5. Deploy the API with `fly deploy`; the release command applies versioned migrations.
6. Verify and dual-review the mainnet candidate, sign it with the external release key, activate it through the operations endpoint, and retain the signed artifact outside the image.
7. Configure `SBTC_EMILY_URL` and `BITCOIN_ESPLORA_URL`, then verify both dependency health and rate limits.
8. Run `npm run test:mainnet-shadow` and `npm run test:sbtc-mainnet`, verify
   `/health`, then query known public Zest and Bitflow addresses and confirm all
   unregistered contracts/tokens are visibly rejected or unsupported. The sBTC
   smoke test requires canonical Stacks ownership, Emily amount/fee/fulfillment,
   and confirmed Bitcoin deposit+sweep evidence to agree.
9. Run the 100-address gate against an independently calculated reference deployment. Preserve and review the zero-mismatch artifact before public beta.

## Before public beta of protocol positions

- Re-run two-source/on-chain verification for every candidate contract immediately before signing.
- Backfill canonical Zest/Bitflow/sBTC projections from each registered activation block and review all `projection_issues`.
- Use the resumable registry-event path (`npm run backfill:registry-events`) until
  every registry checkpoint is complete, then require `npm run audit:projections`
  to pass. The recent block-range command is not sufficient launch evidence.
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
