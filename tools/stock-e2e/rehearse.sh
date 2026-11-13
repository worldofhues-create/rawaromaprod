#!/usr/bin/env bash
# STOCK-E2E-1: the raw-material-to-sale rehearsal, run again. HOLDS NO DATA: the formula sheet is read
# from the path given, at run time, and nothing from it is printed (counts, row numbers and statuses only).
#
#   tools/stock-e2e/rehearse.sh <sheet.xlsx> <runDir outside any repo> <alembic worktree>
#
# Scratch only: RawProd gets a private PostgreSQL 17 (PostGIS) on 127.0.0.1:5561 with databases
# stock_e2e_rp and stock_e2e_rp_vault (rp-up.mjs drops and recreates them); Alembic must already have
# a scratch database named stock_e2e* built by ops/scripts/db-setup.sh, seeded, both RAC imports run.
# Ports: RawProd API 4361, Vault API 4362, Alembic 4371. Stop everything with the PIDs in <runDir>.
set -euo pipefail
XLSX="$1"; RUN="$2"; ALEMBIC="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
case "$RUN" in "$REPO"*|"$ALEMBIC"*) echo "refusing: the run directory holds formula-derived state and must be outside both repositories" >&2; exit 2;; esac
mkdir -p "$RUN"; chmod 700 "$RUN"
TENANT="$(psql -d "${ALEMBIC_DB:-stock_e2e}" -Atc "select id from tenant where slug = 'rac'")"
node "$HERE/rp-up.mjs" "$REPO" "$RUN"
node "$HERE/restart-api.mjs" "$RUN" "$REPO" "ALEMBIC_ASSERTION_TENANT_ID=$TENANT"
export ASSERT_TENANT="$TENANT"
node "$HERE/s1-materials.mjs" "$XLSX" "$RUN"
node "$HERE/s2-receipt.mjs" "$XLSX" "$RUN"
node "$HERE/s3-vault.mjs" "$XLSX" "$RUN"
node "$HERE/probe-audit.mjs" "$RUN"
# Alembic listens and waits for the factory lot of B6 (F1 at 1 kg, 9 x 100 g).
( cd "$ALEMBIC/apps/api" && DATABASE_URL="postgres://$USER@localhost:5432/${ALEMBIC_DB:-stock_e2e}" \
  DATABASE_URL_APP="postgres://alembic_app:alembic_dev_only@localhost:5432/${ALEMBIC_DB:-stock_e2e}" NODE_ENV=development \
  ALEMBIC_PUBLIC_ORIGIN=http://127.0.0.1:4371 SE2E_MAP=1 nohup node scripts/stock-e2e-alembic.ts "$RUN" 4371 \
  http://127.0.0.1:4361/v1/bridge/alembic/events FG-B6-TYPED abf "RAC 09 / 1035 / 100G / ALIKE" > "$RUN/alembic.log" 2>&1 & echo $! > "$RUN/alembic.pid" )
sleep 20
node "$HERE/s7-bridge.mjs" "$RUN"
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F1 5000 B1
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F2 1000 B2
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F2 1000 B3 qcfail
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F3 1000 B4 short
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F2 500 B5 skipmac
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F1 1000 B6
node "$HERE/s6-pack.mjs" "$RUN" B1 abf 100
node "$HERE/s6-pack.mjs" "$RUN" B2 a9pm 50
node "$HERE/s6-pack.mjs" "$RUN" B5 a9pm 50 over
node "$HERE/s6-pack.mjs" "$RUN" B6 abf 100
node "$HERE/probe-scale.mjs" "$XLSX" "$RUN"
node "$HERE/probe-names.mjs" "$RUN"
node "$HERE/probe-queue.mjs" "$RUN"
node "$HERE/s7-bridge.mjs" "$RUN" B1 B6
sleep 40
psql -h 127.0.0.1 -p 5561 -d stock_e2e_rp -v ON_ERROR_STOP=1 -f "$HERE/reconcile-rp.sql"
psql -d "${ALEMBIC_DB:-stock_e2e}" -v ON_ERROR_STOP=1 -f "$ALEMBIC/ops/scripts/stock-e2e/reconcile-alembic.sql"
echo "done: evidence in $RUN (formula-derived; delete it, then drop the scratch databases)"
