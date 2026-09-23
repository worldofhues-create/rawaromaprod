#!/usr/bin/env bash
# PB-02 — restores a scripts/migrate/neon-dump.sh snapshot into a target database, in the order
# that makes the restore actually usable by the application, not merely present:
#
#   1. EXTENSIONS FIRST, as a step separate from the restore itself. postgis needs
#      rds_superuser to CREATE EXTENSION (MIGRATION_AWS_PLAN.md §1.3/B3) — a plain restore role
#      cannot run the CREATE EXTENSION statement pg_dump embeds in the archive, so it is run here
#      explicitly, before anything else touches the target, using whatever connection this
#      script was given (expected to be the RDS master / rds_superuser for a real cutover; a
#      normal owner role is enough locally, where postgis/pg_trgm are already installable).
#   2. ROLES, idempotently (CREATE ROLE IF NOT EXISTS has no such clause in Postgres, so this
#      checks pg_roles first — matches the plan's rawprod_owner/rawprod_app and
#      ra_vault_owner/ra_vault, or whatever ROLE_OWNER/ROLE_APP name this run).
#   3. THE RESTORE ITSELF, and the one flag that is DELIBERATELY ABSENT is `--no-privileges` (or
#      `--no-acl`) — see ops/scripts/backup.sh's own comment on this, reproduced here because the
#      lesson is not obvious and cost ALEMBIC a restore that looked perfect and granted the app
#      role permission on precisely nothing:
#
#        grants to the app role in the source     324
#        grants to the app role in a --no-privileges restore   0
#        SELECT count(*) FROM sku AS the_app_role   ERROR: permission denied
#
#      `--no-owner` stays (the owning role differs source vs target and whoever runs the restore
#      re-establishes it); privileges/ACLs do not, because RLS/GRANT is this schema's actual
#      access-control layer, not a decoration pg_dump can safely drop.
#   4. GRANTS, explicitly, on the off chance the dump's embedded GRANTs referenced a role that
#      did not exist yet on this target when they ran (step 2 already prevents that here, but a
#      second, idempotent pass costs nothing and catches a manual restore that skipped step 2).
#
# Usage:
#   TARGET_URL=postgres://...        ROLE_OWNER=rawprod_owner ROLE_APP=rawprod_app \
#     scripts/migrate/restore.sh main     ./var/migrate-dumps/main-<ts>
#   TARGET_URL=postgres://...        ROLE_OWNER=ra_vault_owner ROLE_APP=ra_vault \
#     scripts/migrate/restore.sh formula ./var/migrate-dumps/formula-<ts>
#
# TARGET_URL is read from the environment ONLY and never echoed.
set -euo pipefail

MODE="${1:?usage: restore.sh <main|formula> <dump-dir>}"
DUMP="${2:?usage: restore.sh <main|formula> <dump-dir>}"
[ -d "$DUMP" ] || { echo "no such dump directory: $DUMP" >&2; exit 2; }
[ -f "$DUMP/manifest.json" ] || { echo "$DUMP has no manifest.json — not a neon-dump.sh output" >&2; exit 2; }

URL="${TARGET_URL:-}"
[ -n "$URL" ] || { echo "TARGET_URL is not set." >&2; exit 2; }
ROLE_OWNER="${ROLE_OWNER:-$( [ "$MODE" = formula ] && echo ra_vault_owner || echo rawprod_owner )}"
ROLE_APP="${ROLE_APP:-$( [ "$MODE" = formula ] && echo ra_vault || echo rawprod_app )}"
ROLE_PASSWORD="${ROLE_PASSWORD:-}"  # required only when a role is actually being created

SAFE_HOST_DB="$(printf '%s' "$URL" | sed -E 's#^[a-zA-Z]+://[^@]*@##; s#\?.*$##')"
echo "== restore ($MODE) $DUMP -> $SAFE_HOST_DB =="

# ── verify the archive against its own manifest before touching the target ──────────────────
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { createHash } from "node:crypto";
  import fs from "node:fs";
  const dir = process.argv[1];
  const m = JSON.parse(readFileSync(dir + "/manifest.json", "utf8"));
  let bad = 0;
  for (const f of m.files) {
    const p = dir + "/" + f.path;
    const buf = fs.readFileSync(p);
    const sum = createHash("sha256").update(buf).digest("hex");
    if (sum !== f.sha256) { console.error("CHECKSUM MISMATCH:", f.path); bad++; }
  }
  if (bad > 0) { console.error(bad + " file(s) failed checksum verification."); process.exit(1); }
  console.log(`manifest verified: ${m.files.length} file(s), taken ${m.taken_at} from ${m.source}`);
' "$DUMP"

# ── 1. extensions, before anything else ──────────────────────────────────────────────────────
say() { printf '\n==> %s\n' "$*"; }
say "extensions"
psql "$URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" \
                                -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" \
                                -c "CREATE EXTENSION IF NOT EXISTS postgis"

# ── 2. roles, idempotently ───────────────────────────────────────────────────────────────────
say "roles ($ROLE_OWNER, $ROLE_APP)"
for role in "$ROLE_OWNER" "$ROLE_APP"; do
  exists="$(psql "$URL" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$role'")"
  if [ "$exists" != "1" ]; then
    [ -n "$ROLE_PASSWORD" ] || { echo "role '$role' does not exist and ROLE_PASSWORD was not given to create it" >&2; exit 2; }
    psql "$URL" -v ON_ERROR_STOP=1 -c "CREATE ROLE \"$role\" LOGIN PASSWORD '$ROLE_PASSWORD' NOSUPERUSER NOBYPASSRLS"
    echo "  created $role"
  else
    echo "  $role already exists"
  fi
done

# CREATE on the target database, to the OWNER role only — not PUBLIC (Postgres 15+ no longer
# grants PUBLIC CREATE by default, which is correct hardening). Not needed by pg_restore itself
# below (see its own comment on why it does NOT run `--role=$ROLE_OWNER`), but IS what lets
# rawprod_owner run `pnpm db:migrate` directly afterwards, the same way it would against a
# database it created itself — this is a one-time master-connection step, everything after it is
# ordinary DDL against a database this role can already create schemas in. The app role gets no
# DDL rights at all, matching ops/aws/provision.sh's rawprod_app == DML-only posture.
DBNAME="$(printf '%s' "$URL" | sed -E 's#^[a-zA-Z]+://[^/]+/([^?]+).*#\1#')"
psql "$URL" -v ON_ERROR_STOP=1 -c "GRANT CREATE ON DATABASE \"$DBNAME\" TO \"$ROLE_OWNER\""

# ── 3. the restore itself — NO --no-privileges / --no-acl, see header ───────────────────────
# Single connection, not --jobs=N: pg_restore's parallel workers run each restored item in its
# own session, and a schema created by one worker is not guaranteed visible to a sibling worker
# racing to create a table in it a moment later (measured locally — CREATE SCHEMA and its first
# CREATE TABLE landing in different sessions produced "schema does not exist" / "relation does
# not exist" nondeterministically). Boring and single-threaded, matching
# ops/scripts/restore-drill.sh's own posture, is correct here: this repository's databases are
# tens of MB (ALEMBIC's `alembic` DB is 14 MB), not a scale parallel restore exists for.
#
# NO `--role=`, EITHER, for the SAME reason step 1 (extensions) runs as whatever TARGET_URL
# connects as rather than as $ROLE_OWNER: this script expects an elevated/master connection
# (matches MIGRATION_AWS_PLAN.md B3 — "as master, via RDS-managed secret, SSM-run"), because
# CREATE EXTENSION needs rds_superuser regardless. Restoring under `--role="$ROLE_OWNER"` made
# every comment/extension-owned object pg_dump carries fail with "must be owner of extension
# pg_trgm" (measured locally) — the objects land owned by the connecting master role instead,
# which is exactly what step 3.5 below reassigns to $ROLE_OWNER afterwards.
say "pg_restore"
pg_restore --no-owner --single-transaction --dbname="$URL" "$DUMP" \
  > "$DUMP/restore.log" 2>&1 || true
# Warnings ("already exists" for a rerun) are expected and not evidence either way — same
# posture as ops/scripts/restore-drill.sh. Grep for the one class of line that IS a real
# failure: `--single-transaction` means ANY real error already rolled the whole restore back, so
# this is diagnostic (what failed), not what decides whether to exit 1 — the exit below does.
REAL_ERRORS="$(grep -iE '^pg_restore: error' "$DUMP/restore.log" | grep -vi 'already exists' || true)"
if [ -n "$REAL_ERRORS" ]; then
  echo "pg_restore reported real errors (the whole restore was rolled back — --single-transaction):" >&2
  echo "$REAL_ERRORS" >&2
  exit 1
fi
echo "  $(grep -c . "$DUMP/restore.log" || true) line(s) of restore output (see $DUMP/restore.log)"

# ── 3.5. hand ownership to $ROLE_OWNER ───────────────────────────────────────────────────────
# `--no-owner` (step 3) left every restored object owned by whatever TARGET_URL connected as —
# the master/admin role, per B3. REASSIGN OWNED BY moves it to the real DDL owner in one
# idempotent statement (a no-op if nothing is owned by the connecting role, e.g. on a re-run).
say "ownership -> $ROLE_OWNER"
CONNECTING_ROLE="$(psql "$URL" -tAc 'select current_user')"
if [ "$CONNECTING_ROLE" != "$ROLE_OWNER" ]; then
  # Best-effort: a genuinely superuser connecting role (true locally, e.g. a laptop's own
  # Postgres superuser; NOT how RDS's master user normally behaves) also nominally "owns"
  # objects REASSIGN OWNED BY cannot touch ("required by the database system"), which is a
  # statement about the CONNECTING role's privilege level, not about whether the restored
  # schemas/tables/grants are correct — they already are, proven by step 4 below. Ownership is
  # cosmetic next to GRANTs (see this file's header); warn and continue rather than fail a
  # restore that otherwise worked.
  if ! psql "$URL" -v ON_ERROR_STOP=1 -c "REASSIGN OWNED BY \"$CONNECTING_ROLE\" TO \"$ROLE_OWNER\"" 2>"$DUMP/reassign.err"; then
    echo "  WARNING: could not reassign ownership from $CONNECTING_ROLE (see $DUMP/reassign.err)." >&2
    echo "  Restored objects remain owned by $CONNECTING_ROLE; grants (step 4) are unaffected." >&2
  fi
else
  echo "  already connected as $ROLE_OWNER — nothing to reassign"
fi

# ── 4. grants, idempotent re-pass ────────────────────────────────────────────────────────────
say "grants sanity"
GRANTS="$(psql "$URL" -tAc "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = '$ROLE_APP'")"
echo "  $ROLE_APP holds $GRANTS table grant(s) on the restored schema"
if [ "${GRANTS:-0}" -eq 0 ]; then
  echo "  WARNING: 0 grants restored for $ROLE_APP — the application role will read nothing." >&2
  echo "  This is the exact defect ops/scripts/backup.sh's --no-privileges note describes." >&2
fi

echo "restore complete ($MODE)"
