# Meaning-first RiskOSfolio milestone

This milestone keeps the blueprint goal — a non-custodial Stacks BTCFi risk layer — while making every primary screen answer:

> Where is my Bitcoin capital, what is it earning, what can go wrong, and what is the safest action I can take right now?

## Shipped in this milestone

### Engine / API
- `packages/risk-engine` emits `meaning`, `whyItMatters`, `ifYouDoNothing`, and `plainMetrics` on every finding.
- Lending findings include LTV, liquidation threshold, estimated liquidation price, and distance narrative.
- LP findings include in-range status, distance within the band, and exit-slippage meaning.
- `packages/portfolio-engine` aggregates net worth, deployed/idle/locked, asset & protocol mix, hold-BTC comparison, BTC stress scenarios, and a `centralAnswer` object.
- `GET /v1/address/{address}/portfolio` is the normative summary endpoint (OpenAPI updated).
- Fixture wallet adapter adds spendable STX and locked sBTC so capital-state charts are exercisable.

### UI (Stacks brand)
Colors aligned to stacks.co: orange `#fc6432`, purple `#5546FF` / `#765bff`, ink `#131416`, canvas `#fdfdfc`.
- Overview: central answer, freshness strip, explained metrics, allocation/protocol/deployment charts, risk score with drivers.
- Positions: selectable cards with per-type meaning, liquidation-distance and LP range charts, provenance.
- Risk: score never alone; scenario table; rich findings.
- Protect: do-nothing narrative, before/after simulation, custody disclaimer.
- Bridge: stepper + state meaning; three-source finality callout.

## Explicitly deferred (still blueprint / UX backlog)
- Full historical portfolio-value timeline and PnL lots
- Rewards / 90-day incentive eligibility endpoints
- Granite, Stacking DAO, Bitcoin Bonds adapters
- Exit-slippage curves at 10/25/50/75/100%, dependency graph, oracle divergence overlays
- SDK/widget distribution module
- Mainnet broadcast (shadow only until registry + 100-address + security gates)

## Verify
```sh
npm test
npm run test:e2e
npm run typecheck
```
