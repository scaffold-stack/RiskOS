# ADR 0001: RiskOS MVP architecture

Status: accepted and extended through production-risk and protected-intent milestones

## Context

The product boundary is defined by the supplied RiskOS technical blueprint. The team is currently unfunded, but the implementation must retain the blueprint's non-custodial, provenance-aware, deterministic, and fail-closed guarantees.

## Decisions

- Use one TypeScript repository with explicit `domain`, `adapters`, `risk-engine`, and `execution` boundaries.
- Start with one API deployment and one static web deployment. Split workers only when ingestion and alert workloads require independent scaling.
- Deploy no RiskOS Clarity contract in the MVP and never accept private keys.
- Use fixture adapters only in development/test. Production startup requires `DATA_MODE=live`.
- Live mode supports public Stacks balances and registry-gated Zest/Bitflow reads. Protocol event projection is enabled only for active, signed registry entries and remains public-beta gated by the 100-address comparison run.
- Use integer/fixed-point calculations. JSON exposes monetary values as strings.
- Begin with ordinary PostgreSQL and native partitioning when persistence lands. TimescaleDB is not an MVP dependency.
- Use Fly.io for the low-cost first deployment; keep containers and storage interfaces portable to AWS when reliability or institutional requirements justify the cost.
- Keep public inspection anonymous. Use domain-bound Stacks message signatures only for private alerts and protective actions; persist session hashes rather than raw tokens.
- Persist alerts and action state in PostgreSQL. Use deterministic alert occurrence keys and intent hashes so retries remain idempotent and auditable.
- Integrate the official `@stacks/connect` request interface lazily in the browser. Mainnet requests remain shadow-only until registry and security gates are signed off.

## Consequences

The first production deployment remains a safe read-only beta while the real-address and source-redundancy gates are open. Wallet ownership, alerts, and the action state machine are implemented and tested; testnet fixtures prove the complete browser-to-API interaction without pretending placeholder contracts or unreviewed mainnet calls are safe.
