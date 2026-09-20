# @riskos/client

Typed SDK for RiskOSfolio's evidence-backed Bitcoin portfolio, risk, yield, alert, and protective-planning API.

## Install

```sh
npm install @riskos/client
```

## Public reads

```ts
import { RiskOsClient } from "@riskos/client";

const riskos = new RiskOsClient({
  baseUrl: "https://api.riskos.example",
});

const overview = await riskos.getOverview("SP...");
console.log(overview.portfolio.risk.classification);
```

## Server-side API access

```ts
const riskos = new RiskOsClient({
  baseUrl: process.env.RISKOS_API_URL!,
  apiKey: process.env.RISKOS_API_KEY!,
  timeoutMs: 10_000,
  retries: 2,
});
```

Never expose a server API key in browser code. Browser wallet workflows should
use the signed wallet challenge methods instead. `verifyWalletChallenge`
returns a short-lived token for in-memory `Authorization: Bearer ...` use; do
not persist that token in local storage.

## Browser embeds and CORS

The API intentionally does not allow arbitrary browser origins. Every wallet or
protocol origin that embeds the read-only widget must be listed in the API's
comma-separated `WEB_ORIGIN` allowlist. Keep paid API keys on a server-side
proxy; never solve an origin error by shipping a key in frontend JavaScript.
Wallet-session cookies additionally require the web app and API to use HTTPS
origins under the same registrable domain. Approved cross-origin clients can
use the short-lived wallet bearer token returned after signature verification.

## Reliability behavior

- GET requests retry transient `408`, `425`, `429`, and `5xx` responses with bounded exponential backoff.
- POST requests are never retried automatically because action and rule creation are not assumed idempotent.
- Requests time out after 15 seconds by default and accept an `AbortSignal`.
- API problems throw `RiskOsClientError` with `status`, `code`, `detail`, `requestId`, and `retryAfterSeconds`.
- Mainnet protective actions remain advisory/shadow-only until the API explicitly reports executable mainnet support.

## Selected methods

- `health`
- `getPlans`, `getDeveloperUsage`, `getAccountPlan`
- `getAccountApiKeys`, `createAccountApiKey`, `revokeAccountApiKey`
- `getOverview`, `getPositions`, `getRisk`, `getPortfolio`, `getHistory`
- `getYieldMarkets`, `getYieldStrategies`, `createYieldAllocation`
- `createWalletChallenge`, `verifyWalletChallenge`, `getWalletSession`, `logoutWalletSession`
- `getAlerts`, `createAlertRule`
- `getPortfolioEvidenceReport`
- `planRepay`, `saveRepayIntent`, `getWalletRequest`, `recordSubmission`
- `getSbtcOperations`

All monetary values are returned as decimal strings. Do not convert them to JavaScript floating-point numbers for accounting or execution.
