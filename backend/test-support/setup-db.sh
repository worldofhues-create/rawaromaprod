#!/usr/bin/env bash
# RP-FAC — creates (idempotently) the throwaway test database the harness runs against.
# Uses TEST_DATABASE_URL if set, else the same default backend/test-support/db.ts falls back to.
set -euo pipefail
URL="${TEST_DATABASE_URL:-postgres://apple@localhost:5432/rawprod_rp_deadtables_test}"
DB="${URL##*/}"
HOSTPORT="${URL#postgres://*@}"
HOSTPORT="${HOSTPORT%%/*}"
HOST="${HOSTPORT%%:*}"
PORT="${HOSTPORT##*:}"
USER="${URL#postgres://}"
USER="${USER%%[:@]*}"
psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1 \
  || psql -h "$HOST" -p "$PORT" -U "$USER" -d postgres -c "CREATE DATABASE \"$DB\""
echo "test database ready: $DB @ $HOST:$PORT"
