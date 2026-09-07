#!/usr/bin/env bash
set -euo pipefail

# The integration suites intentionally TRUNCATE their database. Always create a
# disposable cluster with the exact safety-checked database name instead of
# trusting DATABASE_URL from a developer shell or .env file.
RISKOS_TEST_PG_PORT="${RISKOS_TEST_PG_PORT:-55439}"
RISKOS_TEST_PG_ROOT="$(mktemp -d "${TMPDIR:-/private/tmp}/riskos-pg-isolated.XXXXXX")"
RISKOS_TEST_PG_DATA="${RISKOS_TEST_PG_ROOT}/data"
RISKOS_TEST_PG_SOCKET="${RISKOS_TEST_PG_ROOT}/socket"

cleanup() {
  if [[ -f "${RISKOS_TEST_PG_DATA}/postmaster.pid" ]]; then
    pg_ctl -D "${RISKOS_TEST_PG_DATA}" -m fast -w stop >/dev/null
  fi
  case "${RISKOS_TEST_PG_ROOT}" in
    */riskos-pg-isolated.*) rm -rf -- "${RISKOS_TEST_PG_ROOT}" ;;
    *) printf 'Refusing to remove unexpected test path: %s\n' "${RISKOS_TEST_PG_ROOT}" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

for command in initdb pg_ctl createdb; do
  command -v "${command}" >/dev/null || {
    printf '%s is required for isolated PostgreSQL tests\n' "${command}" >&2
    exit 1
  }
done

mkdir "${RISKOS_TEST_PG_SOCKET}"
initdb -D "${RISKOS_TEST_PG_DATA}" -A trust --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "${RISKOS_TEST_PG_DATA}" \
  -l "${RISKOS_TEST_PG_ROOT}/postgres.log" \
  -o "-p ${RISKOS_TEST_PG_PORT} -k ${RISKOS_TEST_PG_SOCKET} -h 127.0.0.1" \
  -w start >/dev/null
createdb -h "${RISKOS_TEST_PG_SOCKET}" -p "${RISKOS_TEST_PG_PORT}" riskos_integration

export DATABASE_URL="postgresql://127.0.0.1:${RISKOS_TEST_PG_PORT}/riskos_integration"
npm run db:migrate
npm run test:postgres
