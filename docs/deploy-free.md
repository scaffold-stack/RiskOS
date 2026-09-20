## Current free production endpoints

| Service | URL |
| --- | --- |
| Web (Cloudflare Pages) | https://riskosfolio.pages.dev |
| API (Fly.io) | https://riskosfolio-api.fly.dev |
| Postgres (Neon free) | project `riskosfolio` (`billowing-art-89268251`) |

`GET https://riskosfolio-api.fly.dev/health` returns `status: ok`, `dataMode: live`, `registryMode: signed`, Protect advisory-shadow.


| Layer | Service | Notes |
| --- | --- | --- |
| API | [Fly.io](https://fly.io) shared-cpu-1x / 512MB | `auto_stop` keeps machines near $0 |
| Postgres | [Neon](https://neon.tech) free | serverless; set as `DATABASE_URL` |
| Web | [Cloudflare Pages](https://pages.cloudflare.com) | `npm run build:web` → `apps/web/dist` |
| Prices / chain | Hiro key, QuickNode reference, CoinGecko, Coinbase, DefiLlama | already free/public endpoints |

Wallet httpOnly cookies need the web and API on the **same registrable domain**. On free `*.pages.dev` + `*.fly.dev` origins, public address inspect works; Connect wallet sessions may not until you attach a custom domain (also free on Cloudflare).

## 0. Preconditions

- Local `.env` already has production-required keys (`HIRO_API_KEY`, `STACKS_REFERENCE_API_URL`, tokens, fingerprints).
- Signed registry `registry/mainnet/2026-09-13.1.signed.json` is the release in the Docker image.
- Projection backfill can continue against Neon after cutover (`npm run backfill:registry-events:complete`).

## 1. Neon Postgres (free)

1. Create a project at https://console.neon.tech
2. Copy the pooled connection string into local `.env` as `DATABASE_URL`
3. Optionally smoke-migrate locally: `npm run db:migrate`

## 2. Fly API

```sh
fly auth login
fly apps create riskosfolio-api --org personal   # rename in fly.toml if taken
# Point WEB_ORIGIN at the Cloudflare Pages URL once known, e.g.
#   WEB_ORIGIN=https://riskosfolio.pages.dev
chmod +x scripts/fly-secrets-from-env.sh
./scripts/fly-secrets-from-env.sh
fly deploy
fly status
curl -fsS https://riskosfolio-api.fly.dev/health
```

## 3. Cloudflare Pages (free)

```sh
npx wrangler login
# First time: create project linked to this repo, or:
npx wrangler pages project create riskosfolio
VITE_API_URL=https://riskosfolio-api.fly.dev npm run build:web
# Update apps/web/public/_headers connect-src to the Fly API host, then rebuild.
npx wrangler pages deploy apps/web/dist --project-name=riskosfolio
```

Set Pages production env `VITE_API_URL=https://riskosfolio-api.fly.dev`.

Then set Fly secret `WEB_ORIGIN` to the Pages URL and redeploy or `fly secrets set WEB_ORIGIN=...`.

## 4. Post-deploy checks

```sh
curl -fsS https://riskosfolio-api.fly.dev/health
curl -fsS "https://riskosfolio-api.fly.dev/v1/address/SP2R8C36A8KVBBWYC4ASD6V36S2E9VJ0FXWV2T4CP/overview" | head
npm run audit:projections   # after DATABASE_URL points at Neon
```

Protect remains advisory/shadow on mainnet.
