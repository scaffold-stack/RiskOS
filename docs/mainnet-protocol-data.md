# Mainnet protocol data and position milestone

This release follows the supplied blueprint's Appendix B rule: every principal is recorded from a protocol-controlled source and independently checked against its canonical Hiro deployment. Interface hashes are SHA-256 hashes of canonicalized deployed interface JSON, not hashes copied from documentation.

The reviewed, unsigned manifest is `registry/mainnet/2026-09-04.2.candidate.json`. It contains:

- sBTC token, registry, deposit, and withdrawal contracts under `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4`, all activated at block `328228`.
- Zest v2 `v0-8-market`, `v0-market-vault`, asset/egroup registries, and all seven debt vaults under `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7`.
- Bitflow's currently catalogued sBTC/USDCx DLMM pool `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10`.

Each entry records its activation block, deployment transaction, interface hash, retrieval/review date, supported read functions, assets, and two evidence URLs. Recheck all entries at any activation:

```sh
npm run registry:verify -- registry/mainnet/2026-09-04.2.candidate.json
```

## Implemented read paths

- The Stacks balance adapter recognizes sBTC and protocol-locked sBTC metadata only when supplied by the active signed registry.
- The Zest adapter pins a canonical Stacks tip, reads the account position, asset definitions, egroup thresholds, and current debt index at that same tip, and uses the deployed round-up formula for scaled debt.
- The Bitflow adapter accepts only registry-approved pool contracts, combines the public position feed with the active-bin block height, and rejects contract mismatches. Token quantities remain `estimated` until direct NFT/map reconciliation is implemented.
- Registry activation independently re-fetches the deployed interfaces and canonical deployment records before committing the signed version.

## Release boundary

The checked-in candidate is unsigned. Sign it with a trusted Ed25519 release key after dual review (`npm run registry:sign`), then boot with `REGISTRY_SIGNED_PATH` or activate via `npm run registry:activate`. See [signed registry milestone](signed-registry-milestone.md). The Zest market allowlists only the verified `repay` public function for shadow intent construction; mainnet broadcast remains disabled.

A **local/dev** dual-reviewed release is checked in as `registry/mainnet/2026-09-04.2.signed.json` (signer public key `registry/mainnet/dev-release.ed25519.pub.pem`). That key is **not** a production release key.

The canonical projection slice is implemented: Zest vault and Bitflow NFT/liquidity ownership decoders, sBTC registry/Emily/Bitcoin lifecycle reconciliation, hash-bound snapshots, reorg invalidation, and an executable 100-address comparison gate. Public beta remains blocked until the gate is run against 100 real protocol addresses using an independently calculated reference and its zero-mismatch artifact is reviewed.

For a non-mutating smoke test against public mainnet data:

```sh
npm run test:mainnet-shadow
```
