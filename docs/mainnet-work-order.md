# Mainnet work order

This work order follows the blueprint's Detect → Plan → Quote → Simulate → Explain → Request signature → Broadcast → Track → Reconcile sequence.

## Zest recommended scope — implemented in shadow

1. Read normalized single-collateral/single-debt Zest v2 positions at one canonical Stacks tip.
2. Resolve the debt token principal and SIP-010 asset name from the deployed contract interface.
3. Construct the deployed `v0-8-market.repay(ft, amount, on-behalf-of)` call with serialized Clarity values. RiskOS always uses `none` for `on-behalf-of`, so the authenticated wallet can only repay its own position.
4. Apply deny-mode post-conditions limiting the wallet's debt-token outflow to the reviewed amount.
5. Bind every intent to the authenticated address, active signed registry version, adapter version, canonical block, expiry, and integrity hash.
6. Permit a full defensive repayment without USD pricing; partial repayment remains blocked unless fresh valuation proves the 1.35 target health factor.
7. Emit mainnet intents in non-broadcastable shadow mode while collecting comparison evidence.

## Release gates before mainnet broadcast

- Dual-review and externally sign the registry candidate; activate it only after the on-chain verifier confirms the deployment, interface hash, and public `repay` function.
- Pass the blueprint's independently sourced 100-address comparison with zero unexplained mismatches.
- Add fresh Pyth Lazer/DIA valuation for partial repayment simulation and compare results against pinned mainnet execution simulation.
- Run at least two weeks of shadow intents and reconcile predicted calls, fees, and post-position debt against canonical events.
- Complete wallet compatibility, high/critical security remediation, WAF/rate limits, paging, backups, and rollback drills.

Until every gate passes, `executionMode` stays `shadow`; the API returns no wallet-call parameters and rejects submission recording.
