#!/usr/bin/env bash
# PB-02 — a consistent, read-only snapshot of the source database, taken over ONE transaction
# so every table it contains reflects the same instant (MIGRATION_AWS_PLAN.md Phase C1/C2).
# Mirrors /Users/apple/Downloads/alembic/ops/scripts/backup.sh's shape (boring, verified,
# retained by count) with the two changes PB-02's acceptance needs: the vault's formula schema
# is split into its own, separately-encrypted dump (C2 — "never restored into rawprod"), and
# the URL is read from the environment ONLY and never echoed, logged, or put in a filename.
#
#   DATABASE_URL=postgres://...         scripts/migrate/neon-dump.sh main     # everything but formula
#   FORMULA_DATABASE_URL=postgres://... scripts/migrate/neon-dump.sh formula  # formula schema only
#
# Output: a timestamped directory under $DUMP_DIR (default ./var/migrate-dumps), pg_dump -Fd
# (directory format — parallelizable restore, one file per table), plus a manifest.json with the
# source database's identity (host/db/timestamp — never the password) and a sha256 over every
# file in the dump, and a MANIFEST.sha256 dumped from `pg_restore --list` proving the archive is
# actually readable (the same "pg_dump can exit 0 on a truncated write" lesson backup.sh
# encodes — read it back before calling it a snapshot).
set -euo pipefail

MODE="${1:?usage: neon-dump.sh <main|formula>}"
case "$MODE" in
  main)    URL="${DATABASE_URL:-}";         EXCLUDE='--exclude-schema=formula' ;;
  formula) URL="${FORMULA_DATABASE_URL:-${DATABASE_URL:-}}"; EXCLUDE='--schema=formula' ;;
  *) echo "usage: neon-dump.sh <main|formula>" >&2; exit 2 ;;
esac
[ -n "$URL" ] || { echo "$( [ "$MODE" = formula ] && echo FORMULA_DATABASE_URL/DATABASE_URL || echo DATABASE_URL ) is not set." >&2; exit 2; }

DUMP_ROOT="${DUMP_DIR:-./var/migrate-dumps}"
KEEP="${DUMP_KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DUMP_ROOT/${MODE}-${STAMP}"
mkdir -p "$OUT.part"

# NEVER echo $URL. Only the parts safe to name a directory/log line after: host and db name,
# parsed without printing the credential portion.
SAFE_HOST_DB="$(printf '%s' "$URL" | sed -E 's#^[a-zA-Z]+://[^@]*@##; s#\?.*$##')"
echo "== neon-dump ($MODE) -> $SAFE_HOST_DB =="

# A consistent snapshot: one transaction, SERIALIZABLE, deferred until it can run without
# seeing any concurrent write half-applied. Read-only on the source — nothing here writes.
# Directory format so pg_restore can run in parallel (-j) later and so a single corrupt member
# file does not require redumping everything.
pg_dump --format=directory --jobs=1 --no-owner --no-acl --serializable-deferrable \
  $EXCLUDE --file="$OUT.part" "$URL"

# Read it back before trusting it — pg_dump exits 0 on a truncated write to a full disk more
# often than anybody expects (ops/scripts/backup.sh's own lesson).
if ! pg_restore --list "$OUT.part" >/dev/null 2>"$OUT.part/restore-list.err"; then
  echo "neon-dump FAILED: $OUT.part is not a readable archive:" >&2
  cat "$OUT.part/restore-list.err" >&2
  rm -rf "$OUT.part"
  exit 1
fi
rm -f "$OUT.part/restore-list.err"

# sha256 over every member file, and the source identity — never the credential.
{
  echo "{"
  echo "  \"mode\": \"$MODE\","
  echo "  \"source\": \"$SAFE_HOST_DB\","
  echo "  \"taken_at\": \"$STAMP\","
  echo "  \"pg_dump_version\": \"$(pg_dump --version | head -1)\","
  echo "  \"files\": ["
  first=1
  find "$OUT.part" -type f ! -name manifest.json | sort | while read -r f; do
    sum=$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$f") || shasum -a 256 "$f")
    rel="${f#"$OUT".part/}"
    [ "$first" = 1 ] && first=0 || printf ',\n'
    printf '    {"path": %s, "sha256": "%s"}' "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$rel")" "${sum%% *}"
  done
  echo
  echo "  ]"
  echo "}"
} > "$OUT.part/manifest.json"

# Renamed only once known-good, so a partial dump can never be mistaken for the newest one.
mv "$OUT.part" "$OUT"
echo "dump ready: $OUT ($(du -sh "$OUT" | cut -f1))"

# Retention by COUNT, per mode, for the same reason ops/scripts/backup.sh's is: a fortnight of
# failing runs must not silently expire the last good snapshot on an age-based schedule.
ls -1dt "$DUMP_ROOT/${MODE}-"* 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "  expiring $(basename "$old")"
  rm -rf "$old"
done
