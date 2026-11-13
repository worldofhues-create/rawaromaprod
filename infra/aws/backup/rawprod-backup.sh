#!/usr/bin/env bash
# SHIP-RP: a restore point for the `rawprod` database, taken minutes before a deploy moves its schema.
#
# Until this script the only pg_dump of `rawprod` was the one inside the weekly restore drill
# (infra/aws/restore-drill/rawprod-drill.sh, its dump lines), so a migration that damaged rows on a
# Thursday could be answered only with the previous Sunday's dump or an RDS point-in-time restore of the
# whole shared instance, Alembic's database included. This is that drill's dump WITHOUT the restore:
#
#   1. pg_dump -Fc of `rawprod`, read with the owner URL deploy.sh already reads (/etc/rawprod/migrate.env)
#   2. pg_restore --list reads the archive back: it must parse and must hold table data
#   3. upload to s3://<backups>/rawprod/pg_dump/<UTC stamp>.dump, the prefix the drill writes
#   4. one line on stdout that infra/aws/ship.sh parses, and then checks against S3 from the laptop
#
# Read-only on the database. Run as root ON the main box (ship.sh sends it over SSM). The vault's
# database is not dumped here or anywhere: its restore point is RDS point-in-time recovery, which ship.sh
# checks for `--role vault`.
set -euo pipefail
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-west-2}"
export PGSSLROOTCERT="${PGSSLROOTCERT:-/etc/rawprod/rds-global-bundle.pem}" PGSSLMODE="${PGSSLMODE:-verify-full}"
ENVFILE="${RAWPROD_BACKUP_ENVFILE:-/etc/rawprod/migrate.env}"
BUCKET="${RAWPROD_BACKUP_BUCKET:-alembic-backups-859485559854-usw2}"
PREFIX="${RAWPROD_BACKUP_PREFIX:-rawprod/pg_dump}"
# The dump of 2026-11-11 was 1.8 MB. Far below that is an empty or truncated archive, not a small one.
MIN_BYTES="${RAWPROD_BACKUP_MIN_BYTES:-500000}"

die() { echo "rawprod-backup FAILED: $*" >&2; exit 1; }

[ -f "$ENVFILE" ] || die "no $ENVFILE, so the database URL cannot be read"
SRC="$(grep -E '^DATABASE_URL=' "$ENVFILE" | head -1 | cut -d= -f2-)"
[ -n "$SRC" ] || die "$ENVFILE has no DATABASE_URL"

umask 077
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
TS=$(date -u +%Y%m%dT%H%M%SZ)
KEY="$PREFIX/$TS.dump"

pg_dump "$SRC" -Fc -f "$W/rawprod.dump" || die "pg_dump failed"
unset SRC

# Read it back before it is called a backup. An archive pg_restore cannot list cannot be restored.
pg_restore --list "$W/rawprod.dump" > "$W/list.txt" || die "pg_restore --list could not read the archive"
ENTRIES=$(grep -c -v '^;' "$W/list.txt" || true)
TABLES=$(grep -c ' TABLE DATA ' "$W/list.txt" || true)
[ "$TABLES" -gt 0 ] || die "the archive lists no table data ($ENTRIES entries)"

BYTES=$(wc -c < "$W/rawprod.dump" | tr -d ' ')
[ "$BYTES" -ge "$MIN_BYTES" ] || die "the archive is $BYTES bytes, under the floor of $MIN_BYTES"
SHA=$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$W/rawprod.dump") || shasum -a 256 "$W/rawprod.dump" )
SHA="${SHA%% *}"

aws s3 cp --only-show-errors --sse AES256 "$W/rawprod.dump" "s3://$BUCKET/$KEY" || die "upload to s3://$BUCKET/$KEY failed"

echo "rawprod-backup OK bucket=$BUCKET key=$KEY bytes=$BYTES sha256=$SHA entries=$ENTRIES tables=$TABLES"
