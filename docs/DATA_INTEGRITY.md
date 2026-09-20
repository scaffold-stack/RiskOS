# RiskOS data-integrity contract

RiskOS treats absence as unavailable, never as zero. A screen may show a verified token balance while
withholding its USD value, portfolio total, yield, or risk impact. Those are different claims and require
different evidence.

## What each quality state means

- **Verified**: the position quantity came from an approved contract/source at a pinned Stacks block and
  every displayed monetary leg has a non-fixture quote with at least 0.80 confidence.
- **Estimated**: a provider reported the value or rate, but RiskOS has not independently reconstructed it.
- **Degraded**: required evidence is missing, stale, rejected, or only partially available.
- **Unsupported**: no approved decoder or asset definition exists. The raw asset may be listed, but it is
  excluded from monetary analysis.

“Verified” applies to the field carrying the label; it is not a blanket endorsement of a protocol.

## Production display gates

| Output | Required evidence | Failure behavior |
| --- | --- | --- |
| Token quantity | Registry-approved adapter read at a pinned tip | Quantity omitted or position degraded |
| USD leg value | Quote under 15 minutes old and confidence >= 0.70; aggregate use also requires verified quantity and quote confidence >= 0.80 | Quote rejected, or informational value marked estimated and excluded from aggregates |
| Portfolio totals/allocation | Every quantity and every asset/debt value verified | All aggregate dollars and percentages withheld |
| Lending health/LTV | Verified collateral value, debt value, and protocol thresholds | Health and monetary scenarios unavailable |
| Zest current debt | Scaled debt and `get-next-index` from the same pinned tip | Debt omitted; protection blocked |
| Borrow/supply APR | Registry-authorized rate source with validated contract semantics | Rate and debt/yield projection unavailable |
| Bitflow position amount | Canonical pool-event reconstruction reconciled with NFT ownership | Provider quantity remains estimated; aggregates withheld |
| Earned yield/fees | Canonical deposits, withdrawals, claims, incentives, fees, and share/index changes | Earned-to-date unavailable |
| 30-day projection | Verified annualized rate and current verified value | Projection unavailable |
| Protective preflight | Verified current position at the requested block; partial repay also needs <=30-second valuations | Intent blocked |

## Why two history points are not earned yield

`ending value - starting value` mixes deposits, withdrawals, token-price movement, interest, trading fees,
incentives, and impermanent loss. RiskOS stores only canonical, reorg-safe snapshots, but it does not label
their difference “yield.” Earned yield becomes publishable only after the following ledger balances:

`ending position value = opening value + deposits - withdrawals + price effect + verified yield/fees`

For Zest this requires vault-share or liquidity-index checkpoints plus wallet deposit/withdrawal events. For
Bitflow it requires canonical mint/burn liquidity amounts, fee accrual/claims, incentives, and range state.
Until those ledgers reconcile to the current position within a defined tolerance, the UI must say **Not
calculated**.

## Current mainnet limitations

- The candidate registry authorizes Zest vault conversion, interest, utilization, reserve-fee, underlying,
  decimal, and debt-index reads. It also authorizes the StackingDAO STX-per-stSTX and sBTC-per-stBTC rates. Those reads support
  current receipt-token valuation and deterministic rate projections; they do not establish earned-to-date
  yield without the cash-flow ledger described above.
- Bitflow token quantities are independently reconstructed from user-bin shares and canonical bin balances
  when the account has at most 64 bins. Large historical bin sets require the persistent event
  projector; provider quantities remain estimated until that reconstruction reconciles.
- Production requires `STACKS_REFERENCE_API_URL` to point at a separately operated Stacks API/node. Wallet
  balances compare the primary provider's indexed view with pinned core/contract reads on that reference.
  The service refuses identical primary/reference URLs and downgrades evidence when no reference is configured.
- Production evaluates DIA, the keyless CoinGecko and Coinbase Exchange fixed-ID markets, and every Pyth BTC/STX feed available to
  the configured grant. A valuation requires the largest mutually agreeing cluster to contain at least two
  fresh, positive, non-fixture sources within `PRICE_MAX_DIVERGENCE_BPS` (150 bps by default). One denied,
  unavailable, stale, or outlying provider cannot veto two agreeing independent providers, while one source
  can never establish a production valuation. The response records the accepted quorum and any excluded
  outlier. Pyth is optional: a paid feed entitlement is not required when two other independent sources agree.
- Unsupported assets keep their raw on-chain quantity and an explicit `unsupported` state. They are excluded
  from totals rather than treated as zero. When supported positions have accepted price evidence, the UI may
  show a clearly labelled valued net subtotal and its coverage count; it never presents that subtotal as the
  complete portfolio value.
- Canonical history requires PostgreSQL, Chainhook ingestion, registry activation backfill, and continuous
  reorg handling. Run `npm run observe:portfolios` for the configured address cohort after Chainhook and the
  active registry are live. The UI charts value change after two accepted observations, but does not call it
  earned yield until the cash-flow equation above reconciles. Without that infrastructure, history is
  unavailable rather than synthesized.
- BTC stress tests use the complete portfolio when every monetary leg passes policy. If only a valued subset
  is available, RiskOS still models that subset and labels the exact number of excluded positions. An
  unsupported asset can no longer suppress useful stress evidence for unrelated supported positions, and is
  never silently assigned zero.
- Mainnet protection is shadow-only. Its deterministic preflight is not described as an on-chain execution
  or independent contract simulation, and no unknown fee is presented as zero.

## Asset and wrapper valuation coverage

This is a capability matrix, not a claim that every SIP-010 token has a trustworthy market. New and malicious
tokens can be deployed permissionlessly, so “all Stacks assets” cannot safely mean “invent a price for every
contract.” Wallet discovery lists arbitrary SIP-010 balances, while monetary analysis admits only the
following reviewed paths:

| Asset family | Valuation path |
| --- | --- |
| STX | Fresh multi-provider STX/USD quorum |
| sBTC | Fresh multi-provider BTC/USD quorum; sBTC is the protocol's 1:1 BTC-denominated token |
| USDCx | Registry-approved Bitflow sBTC/USDCx market anchored to the BTC/USD quorum, with a depeg bound |
| stSTX | Wallet SIP-010 `ststx-token` identity (registry-approved) valued via pinned StackingDAO `get-stx-per-ststx` × verified STX/USD |
| stSTXbtc | Wallet SIP-010 `ststxbtc-token-v2` identity (registry-approved); deployed 1:1 STX backing × verified STX/USD; separately distributed rewards are not added to backing |
| stBTC | Wallet SIP-010 `stbtc-token` identity (registry-approved) valued via pinned StackingDAO `get-sbtc-per-stbtc` × verified sBTC/USD |
| Zest zSTX, zsBTC, zUSDCx, zstSTX, zstSTXbtc, zstBTC/zvstBTC | Pinned vault `convert-to-assets` × the corresponding verified underlying path; `zvstBTC` is the deployed SIP-010 symbol for the stBTC vault receipt |
| USDH | Registry-approved Bitflow USDh/USDCx active-bin market must agree with independent DIA USDh/USD evidence inside the divergence limit |
| Hermetica sUSDh | Pinned `get-usdh-per-susdh` exchange rate × verified USDH/USD; no 1:1 assumption |
| Granite aeUSDC | Registry-approved Bitflow aeUSDC/USDCx market must agree with an independent USDC/USD reference |
| Granite gUSDC | Pinned `convert-to-assets` share conversion × verified aeUSDC/USD; no 1:1 assumption |
| Zest zUSDH | Pinned vault `convert-to-assets` × verified USDH/USD |
| Bitflow LP | Underlying bin balances reconstructed for an approved pool, then each underlying is valued independently; the pool receipt is excluded to prevent double counting |
| Other SIP-010/NFT assets | Raw quantity and principal are shown as unsupported until decimals, semantics, ownership, and a non-circular valuation path are reviewed |

Every multi-hop wrapper inherits the weakest confidence and freshness in its chain. A wrapper conversion is
not an executable exit quote; slippage remains unknown until a fresh route quote is obtained.

## Release evidence still required

Production operators must retain the signed registry review record, adapter golden-address fixtures,
independent 100-address comparison results, source-health history, projection-issue review, and reconciliation
reports. Passing tests proves implementation behavior; it does not substitute for these external evidence
sets.

## Evidence produced by this repository

- `artifacts/mainnet-address-cohort-evidence.json` records how the 100-address cohort was derived from
  canonical events emitted by registry-approved contracts rather than invented addresses.
- `artifacts/zest-history-100-comparison.json` compares a full canonical Zest event replay with pinned
  `get-position` state reads for 100 addresses. The current artifact records 100 matches and zero mismatches:
  event history came from Hiro and pinned state came from QuickNode. The public QuickNode documentation
  endpoint is suitable for this evidence run, but production still requires an account-owned endpoint with
  a private token and an operational quota/SLA.
- `artifacts/sbtc-mainnet-reconciliation.json` records a live three-system lifecycle check: canonical
  Stacks event projection, Emily operation state, and confirmed Bitcoin transactions from Esplora.
