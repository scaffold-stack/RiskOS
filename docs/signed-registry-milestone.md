# Signed registry activation milestone

## Goal

Replace unsigned candidate bootstraps with an **Ed25519-signed, dual-reviewed** registry release that can be activated locally (memory) or in production (Postgres + operations endpoint). Protect stays advisory.

## What shipped

- `signRegistry` / `createRegistryRelease` / `unwrapRegistryPayload` in `packages/data-foundation`
- Dual-reviewed release envelope (`kind: riskos.registry.release`, ≥2 distinct reviewers)
- CLI:
  - `npm run registry:keygen` — create an Ed25519 keypair (dev/local only)
  - `npm run registry:sign` — sign a candidate with dual `--reviewer` identities
  - `npm run registry:activate` — POST the release to `/v1/operations/registry/activate`
  - `npm run registry:verify` — on-chain interface recheck (unchanged)
- API boot: `REGISTRY_SIGNED_PATH` + `REGISTRY_TRUSTED_KEY_FINGERPRINTS` activates a signed release before falling back to `REGISTRY_CANDIDATE_PATH`
- Candidate path remains non-production only

## Local ceremony

```sh
npm run registry:keygen -- keys/dev-release
# copy fingerprint into .env → REGISTRY_TRUSTED_KEY_FINGERPRINTS=

npm run registry:verify -- registry/mainnet/2026-09-04.2.candidate.json

npm run registry:sign -- registry/mainnet/2026-09-04.2.candidate.json \
  --key keys/dev-release.ed25519.pem \
  --reviewer "alice@example.com" \
  --reviewer "bob@example.com" \
  --out registry/mainnet/2026-09-04.2.signed.json

# .env
# DATA_MODE=live
# REGISTRY_SIGNED_PATH=registry/mainnet/2026-09-04.2.signed.json
# REGISTRY_TRUSTED_KEY_FINGERPRINTS=<fingerprint from keygen>
# REGISTRY_CANDIDATE_PATH can stay as fallback if signed boot fails

npm run dev
# /health → registryMode: "signed"
```

With Postgres + API running:

```sh
npm run registry:activate -- registry/mainnet/2026-09-04.2.signed.json
```

## Production boundary

- Private keys must stay offline / HSM — never commit `keys/*.ed25519.pem`
- Dual reviewers must be real humans after `registry:verify` passes
- Production refuses `REGISTRY_CANDIDATE_PATH`
- Prefer activating through the operations endpoint into Postgres; retain the signed artifact outside the image

## Still next

- Run and archive the 100-address gate artifact
- Chainhook backfill / compose ops
- Keep Protect advisory until shadow period + tx allowlist gates complete
