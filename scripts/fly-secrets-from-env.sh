#!/usr/bin/env bash
# Push production secrets from local .env to Fly without printing values.
# Prerequisites: fly auth login, fly.toml present, Neon DATABASE_URL in .env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "missing .env" >&2
  exit 1
fi

required=(
  DATABASE_URL
  WEB_ORIGIN
  HIRO_API_KEY
  STACKS_REFERENCE_API_URL
  CHAINHOOK_BEARER_TOKEN
  OPERATIONS_BEARER_TOKEN
  ADMIN_PASSWORD_SCRYPT
  ANALYTICS_HASH_SALT
  HIRO_CHAINHOOK_UUID
  REGISTRY_TRUSTED_KEY_FINGERPRINTS
)

missing=()
for key in "${required[@]}"; do
  if ! grep -qE "^${key}=" .env; then
    missing+=("$key")
  fi
done
if ((${#missing[@]})); then
  echo "missing required .env keys: ${missing[*]}" >&2
  exit 1
fi

# Build a temporary env file for fly secrets import (no echo of values).
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  echo "NODE_ENV=production"
  echo "DATA_MODE=live"
  for key in \
    DATABASE_URL \
    WEB_ORIGIN \
    HIRO_API_KEY \
    STACKS_REFERENCE_API_URL \
    STACKS_REFERENCE_API_KEY \
    CHAINHOOK_BEARER_TOKEN \
    OPERATIONS_BEARER_TOKEN \
    ADMIN_PASSWORD_SCRYPT \
    ANALYTICS_HASH_SALT \
    HIRO_CHAINHOOK_UUID \
    REGISTRY_TRUSTED_KEY_FINGERPRINTS \
    PYTH_HERMES_TOKEN \
    COINGECKO_DEMO_API_KEY
  do
    line="$(grep -E "^${key}=" .env || true)"
    if [[ -n "$line" ]]; then
      echo "$line"
    fi
  done
} >"$tmp"

fly secrets import <"$tmp"
echo "Fly secrets imported for $(grep '^app ' fly.toml | awk -F\" '{print $2}')"
