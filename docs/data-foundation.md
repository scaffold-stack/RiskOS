# Real data foundation

This implementation follows the supplied blueprint's requirements for an event-driven read model, replayability, provenance, reorg rollback, signed contract registries, and independent reconciliation.

## Write path

1. Hiro Chainhooks sends apply and rollback block sets to `POST /v1/ingest/chainhooks/stacks`.
2. The endpoint authenticates the configured bearer token.
3. The original payload is hashed and inserted into `raw_chain_events`.
4. Duplicate delivery IDs or identical payload hashes are acknowledged without a second state transition.
5. Registry-approved Zest, Bitflow, and sBTC events are decoded and persisted in the same transaction as their raw block. Unknown/malformed approved-contract shapes are recorded in `projection_issues`; no position fact is invented.
6. Rollback blocks mark blocks, transactions, contract events, and protocol projections non-canonical and invalidate dependent position snapshots.
7. Apply blocks atomically replace any competing canonical block at the same height.
8. The source checkpoint and source-health record update in the same database transaction.

## Continuous mainnet ingestion

The production hook is versioned at
`infra/chainhooks/mainnet-riskosfolio.json`. It uses Hiro Chainhooks v2 and is
intentionally registered disabled first. The consumer accepts both the current
v2 `{ event: { apply, rollback }, chainhook }` envelope and the legacy
top-level envelope, and normalizes v2 transaction operations before projection.

Hiro's consumer secret must be stored as the Fly
`CHAINHOOK_BEARER_TOKEN`; deliveries authenticated by either
`Authorization: Bearer <secret>` or `x-chainhook-consumer-secret: <secret>` are
accepted. Authentication runs before body parsing. The ingestion route has a
bounded 32 MiB default (`CHAINHOOK_BODY_LIMIT_BYTES`) because v2 payloads for
busy blocks can exceed Fastify's 1 MiB default without making that larger limit
global to public API routes. Enable the hook only after the API containing the
matching parser and secret has been deployed. The historical backfill remains a separate,
finite/replayable process; the enabled hook owns forward apply/rollback
delivery.

The production predicate is deliberately narrow: one coinbase event preserves
forward canonical block progress, while registry-scoped contract logs and
sBTC/Bitflow asset events capture projection inputs. Do not restore unscoped
`contract_call`, `contract_log`, `ft_event`, or `nft_event` filters. A broad
predicate filled the free Neon database with unrelated transaction/event data
without creating protocol projections.

Before persistence, the consumer also compacts each delivery: it keeps the
canonical block identity, the original payload SHA-256, and only registry-scoped
projection events. Unrelated full-block transaction operations are discarded,
and `raw_chain_events.payload` stores a deterministic delivery summary rather
than duplicating the full webhook body.

## Canonical projections and snapshots

- Zest ownership and amount changes come from the registry-approved `v0-market-vault` print schema.
- Bitflow ownership comes from the approved pool's `pool-token-id` NFT events, correlated with `pool-mint`/`pool-burn` liquidity events.
- sBTC requests/completions come from the approved `sbtc-registry`; completed-deposit ownership is correlated with the same transaction's approved sBTC mint event.
- Every projection stores the source event key, transaction ID, event index, adapter version, block height, and index-block hash.
- `POST /v1/operations/snapshots/{address}` persists only reads carrying provenance at the current canonical tip. The database locks and rechecks that exact index-block hash before insert.

## sBTC lifecycle

`GET /v1/address/{address}/sbtc-operations` joins canonical registry projections with Emily and a configured Bitcoin Esplora source. `confirmed` from Emily is workflow evidence, not chain finality. The operation reaches `completed` only when the matching canonical registry completion and confirmed Bitcoin transaction evidence agree; disagreement is returned as `evidence-conflict`.

For completed deposits, reconciliation additionally requires the Emily deposit
transaction/output, amount minus recorded Bitcoin fee, and fulfillment sweep to
match the canonical Stacks event and its unique approved sBTC mint recipient.

## 100-address release gate

The blueprint comparison gate is executable and rejects duplicate or undersized samples:

```sh
RISKOS_CANDIDATE_URL=https://candidate.example \
RISKOS_REFERENCE_URL=https://independent-reference.example \
npm run gate:100-addresses -- addresses.json artifacts/mainnet-100-address-comparison.json
```

The reference deployment must calculate positions independently (separate release/data path). The gate compares normalized economic/contract fields for at least 100 unique valid Stacks addresses, emits per-address evidence, and exits non-zero on any mismatch.

## Reconciliation

`POST /v1/operations/reconcile/stacks/{height}` compares the locally canonical index block hash with the current Hiro v2 block response. A mismatch becomes red source health and returns HTTP 409. Missing local data becomes amber. This endpoint should be invoked for the recent confirmation window and by the daily backfill process.

Chainhooks is a trigger and replay source, not final authority. Production should eventually compare a second provider or an owned Stacks node as required by the blueprint.

## Registry

Registry manifests are canonicalized, signed with Ed25519, checked against configured public-key fingerprints, checked for issue/expiry time and network consistency, and then activated transactionally. Activating a version supersedes the previous active version without deleting its audit record.

The reviewed mainnet candidate and its exact verification workflow are documented in [mainnet protocol data](mainnet-protocol-data.md). It remains unsigned and therefore cannot be activated accidentally. The activation endpoint now re-verifies every signed entry against canonical on-chain deployment and interface data before persisting it.

## Local PostgreSQL

```sh
docker compose up -d postgres
npm run db:migrate
BACKFILL_MAX_BLOCKS=20 npm run backfill:chainhook
```

The repository also includes a PostgreSQL integration suite. It intentionally refuses to reset any database not named `riskos_integration`.

```sh
createdb riskos_integration
DATABASE_URL=postgresql:///riskos_integration npm run db:migrate
DATABASE_URL=postgresql:///riskos_integration npm run test:postgres
```

## Production secrets

- `DATABASE_URL`
- `CHAINHOOK_BEARER_TOKEN`
- `OPERATIONS_BEARER_TOKEN`
- `REGISTRY_TRUSTED_KEY_FINGERPRINTS`
- `HIRO_API_KEY` when provider quotas require it

Fixture data is still prohibited under `NODE_ENV=production`.
