#!/usr/bin/env bash
# Deploy one EXACT commit of RawProd to an EC2 host. Nothing else.
#
# Mirrors /Users/apple/Downloads/alembic/ops/deploy/deploy-sha.sh's shape closely: a SHA, never
# a branch (a branch moves between "what was decided" and "what runs"; a SHA cannot); P0 (or
# whoever this lane hands release authority to) selects it, this script only puts it on the box.
# Run ON the host as root, via SSM Session Manager — there is no SSH (MIGRATION_AWS_PLAN.md §1.1:
# the alembic-web SG has no port 22, and this topology does not add one).
#
#   infra/aws/deploy.sh <sha>       deploy that commit
#   infra/aws/deploy.sh --rollback  return the APPLICATION to the previous commit
#   infra/aws/deploy.sh --status    what is live now
#   infra/aws/deploy.sh --version   version + checksum of this file
#
# ── ROLE: WHICH HOST THIS SCRIPT THINKS IT IS ────────────────────────────────────────────────
# ONE script, run on either EC2 the plan defines — RAWPROD_ROLE picks which systemd units and
# which health checks apply. RAWPROD_ROLE=main (default) manages rawprod-migrate/rawprod-api and
# checks the factory+platform static roots + /health through nginx; RAWPROD_ROLE=vault manages
# vault-migrate/vault-api and checks only /health (the vault console is allow-listed — see
# infra/aws/nginx/vault-allowlist.conf.placeholder — so this script, run locally on that box,
# talks to 127.0.0.1 directly rather than through the public hostname).
#
# ── APPLICATION ROLLBACK IS NOT DATABASE ROLLBACK ────────────────────────────────────────────
# Identical reasoning to deploy-sha.sh's own note: migrations here are forward-only in
# deployment (nothing in scripts/db-migrate.ts runs a down-migration), so `--rollback` checks
# whether the target commit's migration set is a SUBSET of what this database's
# `public.schema_migrations` ledger already has recorded — if the ledger names a migration file
# the target SHA does not contain, this refuses instead of running that old code against a
# schema it has never seen. See compat_check() below; the ledger row format is
# scripts/db-migrate.ts's own `${file}#${blockIndex}#${target}`.
set -euo pipefail

RAWPROD_DEPLOY_WRAPPER_VERSION="1"
ROLE="${RAWPROD_ROLE:-main}"

APP="${RAWPROD_APP_DIR:-/srv/rawprod/app}"
ETC="${RAWPROD_STATE_DIR:-/etc/rawprod}"
STATE_DIR="${RAWPROD_STATE_FILE_DIR:-/srv/rawprod}"
STATE="$STATE_DIR/DEPLOYED_SHA"
PREV="$ETC/previous-sha"
ENVFILE="$ETC/$([ "$ROLE" = vault ] && echo vault-migrate.env || echo migrate.env)"
PNPM="${RAWPROD_PNPM:-/usr/bin/pnpm}"

if [ "$ROLE" = vault ]; then
  MIGRATE_UNIT=vault-migrate.service
  API_UNIT=vault-api.service
  API_PORT="${RAWPROD_API_PORT:-4100}"
else
  MIGRATE_UNIT=rawprod-migrate.service
  API_UNIT=rawprod-api.service
  API_PORT="${RAWPROD_API_PORT:-4100}"
fi

die() { echo "FATAL: $*" >&2; exit 1; }
say() { echo "==> $*"; }

status() {
  echo "role     : $ROLE"
  echo "deployed : $(cat "$STATE" 2>/dev/null || echo '(unrecorded)')"
  echo "previous : $(cat "$PREV" 2>/dev/null || echo '(none)')"
  echo "checkout : $(cd "$APP" && sudo -u rawprod git rev-parse HEAD 2>/dev/null || echo '?')"
  for u in "$MIGRATE_UNIT" "$API_UNIT"; do
    printf '%-24s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo '?')"
  done
}

health() {
  local api
  api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$API_PORT/health" || echo 000)
  echo "  api :$API_PORT/health : $api"
  if [ "$ROLE" = main ]; then
    local factory platform
    factory=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: rawfactory.huecycle.in' http://127.0.0.1/ || echo 000)
    platform=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: rawplatform.huecycle.in' http://127.0.0.1/ || echo 000)
    echo "  nginx factory / : $factory"
    echo "  nginx platform /: $platform"
    [ "$api" = "200" ] && [ "$factory" = "200" ] && [ "$platform" = "200" ]
  else
    [ "$api" = "200" ]
  fi
}

version() {
  local sum
  sum=$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "${BASH_SOURCE[0]}") \
        || shasum -a 256 "${BASH_SOURCE[0]}" ) 2>/dev/null
  echo "rawprod deploy wrapper version $RAWPROD_DEPLOY_WRAPPER_VERSION"
  echo "sha256 ${sum%% *}"
  echo "source infra/aws/deploy.sh in the rawprod repository"
}

# Can $1 run against the schema this database's ledger says is already applied? Mirrors
# alembic/ops/deploy/rollback-compat.mjs's question, answered against
# public.schema_migrations (id = "<migration-file>#<blockIndex>#<target>") instead of
# node-pg-migrate's `pgmigrations` table — same shape, same verdict logic: every FILE this role's
# connection(s) have recorded as applied must exist in the target SHA's scripts/migrations/, or
# the target has never seen a migration this database already ran.
compat_check() {
  local sha="$1"
  [ -f "$ENVFILE" ] || die "no $ENVFILE, so the applied migrations cannot be read"
  local urls=()
  local dburl fburl
  dburl="$(grep -E '^DATABASE_URL=' "$ENVFILE" | head -1 | cut -d= -f2-)"
  fburl="$(grep -E '^FORMULA_DATABASE_URL=' "$ENVFILE" | head -1 | cut -d= -f2-)"
  [ -n "$dburl" ] && urls+=("$dburl")
  [ -n "$fburl" ] && urls+=("$fburl")
  [ ${#urls[@]} -gt 0 ] || die "$ENVFILE has neither DATABASE_URL nor FORMULA_DATABASE_URL"

  local target_files applied file ok=0 rc=0
  target_files="$(git -C "$APP" ls-tree -r --name-only "$sha" scripts/migrations 2>/dev/null | xargs -n1 basename)"
  [ -n "$target_files" ] || die "target $sha has no scripts/migrations/ — cannot judge compatibility"

  for url in "${urls[@]}"; do
    applied="$(psql "$url" -tAc "select distinct split_part(id, '#', 1) from public.schema_migrations" 2>/dev/null || true)"
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      if ! grep -qxF "$file" <<<"$target_files"; then
        echo "  ledger on this connection has applied '$file', which $sha does not contain" >&2
        rc=1
      fi
    done <<<"$applied"
  done
  return $rc
}

deploy() {
  local sha="$1" rollback="${2:-no}"
  [ -d "$APP/.git" ] || die "no checkout at $APP"

  say "fetching"
  sudo -u rawprod git -C "$APP" fetch --all --tags --prune --quiet

  local full
  full=$(sudo -u rawprod git -C "$APP" rev-parse --verify "${sha}^{commit}" 2>/dev/null) \
    || die "commit $sha does not exist in the repository"
  say "target $full (role=$ROLE)"

  if [ "$rollback" = yes ]; then
    say "can $full run against what this database's ledger says is already applied?"
    if ! compat_check "$full"; then
      cat >&2 <<EOM

REFUSED: THIS IS NOT A ROLLBACK THAT IS SAFE TO DO.

  This database's public.schema_migrations ledger has recorded a migration file $full does not
  contain. Migrations here are forward-only in deployment — nothing in scripts/db-migrate.ts runs
  a down-migration — so putting that commit back would run it against a schema it has never seen.

  WHAT IS ACTUALLY AVAILABLE, in the order they cost:
  1. A FORWARD FIX. Ship a new commit. Almost always the answer, and the only one that loses no
     writes.
  2. A POINT-IN-TIME RESTORE (RDS PITR, or scripts/migrate/restore.sh from the last
     scripts/migrate/neon-dump.sh snapshot) to just before the migration ran. THIS IS RECOVERY,
     NOT FAILOVER: every write after that instant is gone. The owner's decision, not an
     operator's.
  3. Roll the application back to a commit the CURRENT schema can still serve, if one exists —
     run --status, pick an older SHA, and this check will say.

EOM
      exit 3
    fi
    say "yes — nothing in the ledger is ahead of $full"
  fi

  local current
  current=$(sudo -u rawprod git -C "$APP" rev-parse HEAD)
  [ "$full" = "$current" ] && say "already at $full; continuing so a partial deploy self-heals"

  say "checking out"
  sudo -u rawprod git -C "$APP" checkout --quiet --detach "$full"

  say "installing dependencies"
  sudo -u rawprod env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$PNPM" -C "$APP" install --frozen-lockfile >/dev/null

  say "build"
  sudo -u rawprod "$PNPM" -C "$APP" -r build >/dev/null 2>&1 || say "  (no-op or non-fatal: this codebase runs the API from source via the swc loader — see DEPLOY.md §3)"

  # Migrations BEFORE the API restarts — same ordering rule as ALEMBIC's deploy-sha.sh and the
  # same reason: an API that started against last week's schema is worse than one that refused
  # to start. On a --rollback this is a no-op by construction: compat_check already established
  # the ledger holds nothing the target lacks, so every block in scripts/migrations/ is already
  # applied and db:migrate's own ledger check (scripts/db-migrate.ts) skips all of them.
  say "migrations ($MIGRATE_UNIT)"
  systemctl restart "$MIGRATE_UNIT"
  systemctl is-active --quiet "$MIGRATE_UNIT" || die "migrations failed — see: journalctl -u $MIGRATE_UNIT"

  say "restarting $API_UNIT"
  systemctl restart "$API_UNIT"
  sleep 8

  say "health"
  if health; then
    if [ "$rollback" = yes ]; then
      cat <<EOM

ROLLED BACK TO $full.

  WHAT WAS ROLLED BACK:  the APPLICATION ($ROLE role). $APP is at $full and $API_UNIT is running
                         it.
  WHAT WAS NOT:          the DATABASE. Migrations are forward-only here; nothing about the data
                         has been undone.

EOM
    else
      [ -f "$STATE" ] && cp "$STATE" "$PREV"
      say "DEPLOYED $full ($ROLE)"
    fi
    mkdir -p "$(dirname "$STATE")"
    echo "$full" > "$STATE"
  else
    echo "HEALTH CHECK FAILED. The previous commit is still in $PREV;" >&2
    echo "run '$0 --rollback' to return to it." >&2
    exit 1
  fi
}

case "${1:-}" in
  --version)  version ;;
  --status)   status ;;
  --rollback)
    [ -s "$PREV" ] || die "no previous SHA recorded"
    say "rolling back to $(cat "$PREV")"
    deploy "$(cat "$PREV")" yes
    ;;
  "")         die "usage: $0 <sha> | --rollback | --status | --version   (RAWPROD_ROLE=main|vault)" ;;
  -*)         die "unknown option $1" ;;
  *)          deploy "$1" no ;;
esac
