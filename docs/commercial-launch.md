# Commercial launch

RiskOSfolio monetizes persistent monitoring, deeper evidence, supported integrations, and API capacity. Public current-state inspection and yield exploration remain free. Mainnet Protect is advisory/shadow-only and carries no execution fee.

## Enforced plans

- **Free — $0:** public inspection, explore mode, 30 history observations, and one alert rule.
- **Pro — $29/month:** recommendation mode, extended history, up to ten alert rules, and owner-authenticated evidence reports.
- **Treasury — $299/month:** up to one hundred alert rules, extended history, evidence reports, and priority support during the pilot.
- **API Growth — $399/month:** 50,000 metered requests, an API key, extended history, and recommendation mode.
- **Protocol Partner — contract:** custom adapter work, a 1,000,000-request default, monitoring, and priority support.

The plan catalog is served by `GET /v1/plans`; the web pricing page reads it rather than duplicating prices.

## Current launch boundary

- API keys are random 256-bit secrets. Only SHA-256 hashes are stored; the raw key is returned once.
- API usage is counted atomically per UTC calendar month in Postgres.
- Revoked, unknown, and exhausted keys fail closed.
- Anonymous address, yield, action-preview, and challenge routes are limited per
  IP and API instance (`PUBLIC_RATE_LIMIT_PER_MINUTE`, default 60). Keep a
  Cloudflare/WAF limit in front when scaling to multiple API instances.
- `recommend` yield mode, extended history beyond 30 observations, and additional alert rules are entitlement-gated.
- Wallet plans are stored independently of the payment provider. This keeps Stripe, invoice, or USDC settlement events outside risk calculations.
- Provisioning is manual until a reviewed billing webhook is deployed. The product and API explicitly report `billingState: manual-provisioning`.

## Provision an API customer

```sh
curl -fsS https://riskosfolio-api.fly.dev/v1/operations/api-keys \
  -H "authorization: Bearer $OPERATIONS_BEARER_TOKEN" \
  -H "content-type: application/json" \
  --data '{"name":"Customer production","plan":"developer"}'
```

Copy the returned `apiKey` immediately. It cannot be recovered from the database.

Check usage with the customer key:

```sh
curl -fsS https://riskosfolio-api.fly.dev/v1/developer/usage \
  -H "x-api-key: $RISKOS_API_KEY"
```

Revoke a compromised or cancelled key:

```sh
curl -fsS -X POST \
  "https://riskosfolio-api.fly.dev/v1/operations/api-keys/$KEY_ID/revoke" \
  -H "authorization: Bearer $OPERATIONS_BEARER_TOKEN"
```

## Grant a paid wallet plan

```sh
curl -fsS https://riskosfolio-api.fly.dev/v1/operations/entitlements \
  -H "authorization: Bearer $OPERATIONS_BEARER_TOKEN" \
  -H "content-type: application/json" \
  --data '{
    "address":"SP...",
    "plan":"pro",
    "endsAt":"2026-10-20T00:00:00.000Z",
    "source":"manual"
  }'
```

An authenticated wallet reads its effective plan through `GET /v1/account/plan`.

## SDK release

```sh
npm run build:sdk
cd packages/client
npm pack --dry-run
```

The SDK is standalone: its published declarations do not import monorepo-internal packages. Publishing remains an explicit release action; no package is published by the build.

## Before self-service billing

1. Choose the payment provider and create server-owned price IDs.
2. Verify signed webhook payloads and persist event IDs for idempotency.
3. Translate successful subscription states into `commercial_entitlements`; never trust browser success redirects.
4. Handle cancellation, failed renewal, refund, dispute, and plan-change events.
5. Add invoice and tax identity fields without putting payment data into wallet-session tables.
6. Configure `VITE_SALES_URL` so the pricing page can route paid-plan requests during the manual pilot.

Sponsored protocol work must not alter risk scores, market eligibility, or yield ranking. Any sponsorship should be disclosed separately from evidence.
