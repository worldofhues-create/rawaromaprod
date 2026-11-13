#!/usr/bin/env bash
# STOCK-FIX-RP: the rehearsal's RawProd leg on its own (no Alembic box): raw materials (one import), receipt,
# the Vault, six batches through the stations, packing, each batch's remnant, the probes, and the
# reconciliation. HOLDS NO DATA, as rehearse.sh: the sheet is read from the path given, at run time.
#   tools/stock-e2e/rehearse-rp.sh <sheet.xlsx> <runDir outside any repo>
# The bridge leg is rehearse.sh (it needs an Alembic scratch database). The tenant here is a fixed scratch
# uuid, so facts the relay sends park for want of a peer, as they would with Alembic down.
set -euo pipefail
XLSX="$1"; RUN="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
case "$RUN" in "$REPO"*) echo "refusing: the run directory holds formula-derived state and must be outside the repository" >&2; exit 2;; esac
mkdir -p "$RUN"; chmod 700 "$RUN"
TENANT="${REHEARSAL_TENANT:-0f1e2d3c-4b5a-4968-8776-655443322110}"
node "$HERE/rp-up.mjs" "$REPO" "$RUN"
node "$HERE/restart-api.mjs" "$RUN" "$REPO" "ALEMBIC_ASSERTION_TENANT_ID=$TENANT"
export ASSERT_TENANT="$TENANT"
node "$HERE/s1-materials.mjs" "$XLSX" "$RUN"
node "$HERE/s2-receipt.mjs" "$XLSX" "$RUN"
node "$HERE/s3-vault.mjs" "$XLSX" "$RUN"
node "$HERE/probe-audit.mjs" "$RUN"
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F1 5000 B1
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F2 1000 B2
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F2 1000 B3 qcfail
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F3 1000 B4 short
node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F2 500 B5 skipmac
REVEAL_PROBE=B6 node "$HERE/s4-produce.mjs" "$XLSX" "$RUN" F1 1000 B6
node "$HERE/s6-pack.mjs" "$RUN" B1 abf 100
node "$HERE/s6-pack.mjs" "$RUN" B2 a9pm 50
node "$HERE/s6-pack.mjs" "$RUN" B5 a9pm 50 over
node "$HERE/s6-pack.mjs" "$RUN" B6 abf 100
node "$HERE/s8-remnant.mjs" "$RUN"
node "$HERE/probe-scale.mjs" "$XLSX" "$RUN"
node "$HERE/probe-names.mjs" "$RUN"
node "$HERE/probe-queue.mjs" "$RUN"
/opt/homebrew/opt/postgresql@17/bin/psql -h 127.0.0.1 -p 5561 -d stock_e2e_rp -v ON_ERROR_STOP=1 -f "$HERE/reconcile-rp.sql"
echo "done: evidence in $RUN (formula-derived; delete it, then stop the PIDs and the private PostgreSQL)"
