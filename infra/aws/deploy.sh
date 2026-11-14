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
# checks the API's /health directly plus the factory+platform consoles over HTTPS (see health());
# RAWPROD_ROLE=vault manages vault-migrate/vault-api and checks only /health (the vault console is allow-listed — see
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
#
# ── VAULT-FIT: THE TOOLS ARE FOUND, AND THE VAULT IS STAGED BESIDE THE RUNNING CODE ──────────
# Wrapper version 3 assumed /usr/bin/pnpm, and the vault box has none: Node and pnpm live in
# /opt/node-v22.12.0/bin, and sudo's secure_path does not include it, so even that pnpm (a
# `#!/usr/bin/env node` script) cannot start under `sudo -u rawprod`. On 14 Nov 2026 the vault
# deploy of 7751d6da died there (exit 127) AFTER `git checkout` had already put the new commit
# under a service that runs TypeScript from the checkout: from that moment a crash
# (Restart=on-failure) or a reboot would have started new code on old dependencies and an
# unmigrated schema. find_tools() now looks for node 22 and pnpm (RAWPROD_NODE_BIN / RAWPROD_PNPM
# still win) and runs pnpm with node's directory on PATH, and refuses before anything changes if
# either is missing.
#
# STAGED (RAWPROD_STAGED=1, the default for the vault role): the commit is cloned beside the live
# checkout, installed, built and migrated FROM THAT CLONE while the service keeps running the old
# tree untouched; only then are the two directories swapped and the service restarted. Any failure
# before the swap leaves $APP exactly as it was. A failed health check after the swap swaps back and
# restarts the old tree. The live checkout is never `git checkout`-ed, so files an old build left
# modified in it (web/admin/.next was TRACKED up to 3f6a198, and every deploy before ADMIN-BUILD-1
# rebuilt it) cannot block or be carried into a deploy. The main role keeps the in-place path that
# deployed 7751d6da green on 14 Nov; RAWPROD_STAGED=1 opts it in.
set -euo pipefail

RAWPROD_DEPLOY_WRAPPER_VERSION="4"
ROLE="${RAWPROD_ROLE:-main}"

APP="${RAWPROD_APP_DIR:-/srv/rawprod/app}"
ETC="${RAWPROD_STATE_DIR:-/etc/rawprod}"
STATE_DIR="${RAWPROD_STATE_FILE_DIR:-/srv/rawprod}"
STATE="$STATE_DIR/DEPLOYED_SHA"
PREV="$ETC/previous-sha"
ENVFILE="$ETC/$([ "$ROLE" = vault ] && echo vault-migrate.env || echo migrate.env)"
PNPM="${RAWPROD_PNPM:-}"          # found by find_tools when unset
NODE_BIN="${RAWPROD_NODE_BIN:-}"  # the directory holding node 22; found by find_tools when unset
RUN_USER="${RAWPROD_RUN_USER:-rawprod}"
STAGED="${RAWPROD_STAGED:-$([ "$ROLE" = vault ] && echo 1 || echo 0)}"
# The staged clone shares the pnpm store and git objects by hard link, so it is small; the floor is
# for node_modules' own entries and the build's dist output. Checked before anything is written.
MIN_FREE_MB="${RAWPROD_MIN_FREE_MB:-1500}"
TOOL_PATH=""

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

# ONE LOCK FOR THE HOST, shared with alembic ops/deploy/deploy-sha.sh. On 2026-11-07 this
# script's build and Alembic's ran together on a 3.8 GB no-swap box, the kernel killed Alembic's
# next-build, and the storefront was down for ten minutes. flock, so a killed deploy frees it.
HOST_LOCK="${RAWPROD_HOST_LOCK:-/run/lock/raw-host-deploy.lock}"
MEMINFO="${RAWPROD_MEMINFO:-/proc/meminfo}"
# This build held about 1450 MB RSS in that OOM table; a quiet host has about 1990 available.
# Main host only. The vault box is a t4g.small with about 1400 available and nothing else building
# on it, so 1800 would refuse every vault deploy; set RAWPROD_MIN_BUILD_MEM_MB there to give it one.
MIN_BUILD_MEM_MB="${RAWPROD_MIN_BUILD_MEM_MB:-$([ "$ROLE" = vault ] && echo 0 || echo 1800)}"

take_host_lock() {
  command -v flock >/dev/null 2>&1 || die "no flock on this host, so another deploy cannot be excluded"
  exec 9>>"$HOST_LOCK" || die "cannot open $HOST_LOCK"
  flock -n 9 || die "another deploy holds the host lock: $(tail -1 "$HOST_LOCK" 2>/dev/null)"
  printf 'rawprod pid %s since %s\n' "$$" "$(date -u +%FT%TZ)" >&9
}

require_build_memory() {
  local kb mb
  kb=$(awk '/^MemAvailable:/ {print $2}' "$MEMINFO" 2>/dev/null || true)
  [ -n "$kb" ] || die "cannot read available memory from $MEMINFO"
  mb=$((kb / 1024))
  [ "$mb" -ge "$MIN_BUILD_MEM_MB" ] || die "not enough memory to build: ${mb}MB available, ${MIN_BUILD_MEM_MB}MB required"
}

as_user() { sudo -u "$RUN_USER" "$@"; }
# pnpm as the app user, with node 22's directory first on PATH. Without it, sudo's secure_path finds
# no node on the vault box and pnpm's `#!/usr/bin/env node` fails: "env: node: No such file".
pn() { sudo -u "$RUN_USER" env "PATH=$TOOL_PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$PNPM" "$@"; }

# VAULT-FIT: node 22 and pnpm, wherever this host keeps them, as a PAIR: the first directory holding
# both a node 22 and a pnpm. The order keeps the main box exactly as it was (its pair is in /usr/bin,
# found first through PATH); the vault box has its pair only in /opt/node-v22.*/bin, which is also
# where both API units' ExecStart takes node from. A pnpm with no node beside it (the pnpm22 wrapper)
# is paired with the first node 22 found.
find_tools() {
  local c d
  is22() { [ -x "$1/node" ] && [ "$("$1/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)" = 22 ]; }
  local -a cands=()
  for c in "$(command -v pnpm 2>/dev/null || true)" "$(command -v node 2>/dev/null || true)"; do [ -n "$c" ] && cands+=("$(dirname "$c")"); done
  cands+=(/usr/bin /usr/local/bin)
  for c in $(ls -d "${RAWPROD_OPT_DIR:-/opt}"/node-v22*/bin 2>/dev/null | sort -rV); do cands+=("$c"); done
  if [ -z "$NODE_BIN" ] && [ -z "$PNPM" ]; then
    for d in "${cands[@]}"; do
      if [ -x "$d/pnpm" ] && is22 "$d"; then NODE_BIN="$d"; PNPM="$d/pnpm"; break; fi
    done
  fi
  if [ -z "$NODE_BIN" ]; then
    for d in "${cands[@]}"; do is22 "$d" && { NODE_BIN="$d"; break; }; done
  fi
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN/node" ] \
    || die "no node 22 on this host (looked on PATH, in /usr/bin, /usr/local/bin and /opt/node-v22*/bin). Set RAWPROD_NODE_BIN. Nothing was changed"
  if [ -z "$PNPM" ]; then
    for c in "$(command -v pnpm 2>/dev/null || true)" "$NODE_BIN/pnpm" /usr/bin/pnpm /usr/local/bin/pnpm /usr/local/lib/rawaroma/pnpm22; do
      [ -n "$c" ] && [ -x "$c" ] && { PNPM="$c"; break; }
    done
  fi
  [ -n "$PNPM" ] && [ -x "$PNPM" ] \
    || die "no pnpm on this host (looked on PATH, beside $NODE_BIN/node, in /usr/bin, /usr/local/bin and /usr/local/lib/rawaroma/pnpm22). Set RAWPROD_PNPM. Nothing was changed"
  TOOL_PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  # It must RUN as the app user, not merely exist: the 14 Nov failure was a pnpm that existed.
  local v
  v=$(cd / && pn --version 2>&1) || die "pnpm at $PNPM does not run as $RUN_USER with node from $NODE_BIN: $v. Nothing was changed"
  say "tools: node $("$NODE_BIN/node" -v) ($NODE_BIN), pnpm $v ($PNPM)"
}

require_free_disk() { # dir
  local mb
  mb=$(df -Pk "$1" 2>/dev/null | awk 'NR==2 {print int($4/1024)}')
  [ -n "$mb" ] || die "cannot read free disk for $1"
  [ "$mb" -ge "$MIN_FREE_MB" ] || die "not enough disk to stage the commit beside the running one: ${mb}MB free in $1, ${MIN_FREE_MB}MB required. Nothing was changed"
}

status() {
  echo "role     : $ROLE"
  echo "deployed : $(cat "$STATE" 2>/dev/null || echo '(unrecorded)')"
  echo "previous : $(cat "$PREV" 2>/dev/null || echo '(none)')"
  echo "checkout : $(cd "$APP" && sudo -u rawprod git rev-parse HEAD 2>/dev/null || echo '?')"
  for u in "$MIGRATE_UNIT" "$API_UNIT"; do
    printf '%-24s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo '?')"
  done
}

# HEALTH, checked where each thing actually answers (OPS_GREEN §17).
#
# The API directly on 127.0.0.1:$API_PORT/health — no proxy in the way. The static consoles over
# HTTPS with the real hostname: port 80 on this box only ever answers `301 -> https` for every
# huecycle.in name (infra/aws/nginx/huecycle-hosts.conf), so the old `curl -H Host: ... http://
# 127.0.0.1/` got a 301, health() failed on every deploy, and DEPLOYED_SHA was never written.
# `--resolve NAME:443:127.0.0.1` sends SNI and Host for NAME to this box's own nginx, so the
# certificate is VERIFIED for that name (no -k) and the vhost that serves the public is the one
# checked. Overridable for a box serving other names.
FACTORY_HOST="${RAWPROD_FACTORY_HOST:-rawfactory.huecycle.in}"
PLATFORM_HOST="${RAWPROD_PLATFORM_HOST:-rawplatform.huecycle.in}"

site_code() { # host -> HTTP status of GET https://host/ served by THIS box's nginx
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    --resolve "$1:443:127.0.0.1" "https://$1/" || echo 000
}

health() {
  local api
  api=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$API_PORT/health" || echo 000)
  echo "  api 127.0.0.1:$API_PORT/health : $api"
  if [ "$ROLE" = main ]; then
    local factory platform
    factory=$(site_code "$FACTORY_HOST")
    platform=$(site_code "$PLATFORM_HOST")
    echo "  https://$FACTORY_HOST/  : $factory"
    echo "  https://$PLATFORM_HOST/ : $platform"
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

  require_build_memory
  find_tools

  local current
  current=$(sudo -u rawprod git -C "$APP" rev-parse HEAD)
  [ "$full" = "$current" ] && say "already at $full; continuing so a partial deploy self-heals"

  if [ "$STAGED" = 1 ]; then
    deploy_staged "$full" "$rollback" "$current"
    return
  fi

  say "checking out"
  sudo -u rawprod git -C "$APP" checkout --quiet --detach "$full"

  say "installing dependencies"
  pn -C "$APP" install --frozen-lockfile >/dev/null

  say "build"
  # Required: a failed or OOM-killed build stops here, before migrations and the restart. The API
  # runs from source, so this compiles only the packages that emit a dist; output stays visible.
  # What is built, and why serially: build_in().
  local build_rc=0
  build_in "$APP" || build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    [ "$build_rc" -eq 137 ] && echo "exit 137 is SIGKILL: most likely out of memory, see dmesg" >&2
    die "build failed (exit $build_rc). No migration ran and $API_UNIT was not restarted, so it is still running $current, but $APP is now at $full: deploy again, or deploy $current"
  fi

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
    record_green "$full" "$rollback"
  else
    echo "HEALTH CHECK FAILED. The commit that last passed this check is still in $STATE;" >&2
    echo "run '$0 --rollback' to return to it (from the laptop: infra/aws/ship.sh --rollback --apply)." >&2
    exit 1
  fi
}

# Serial because the vault box has about 970 MB available: this peaks at 810 MB one package at a
# time and 1321 MB at pnpm's default concurrency. The exclusions are here as well as in the tree
# because --rollback runs this against older commits, which still have web/admin (nothing serves it,
# and it cannot build) and @core/api's `nest build` (nothing runs its output, and it writes compiled
# files beside the sources).
build_in() { # tree
  pn -C "$1" -r --workspace-concurrency=1 --filter '!@core/admin-shell' --filter '!@core/api' build
}

record_green() { # full sha, rollback yes|no
  local full="$1" rollback="$2"
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
}

# VAULT-FIT: the order for a service that runs TypeScript from its checkout.
#
#   1 clone the commit to $STAGE beside $APP       the running service and $APP are not touched
#   2 install, build                               in $STAGE
#   3 migrate, FROM $STAGE                         systemd-run with the migrate unit's own env file and
#                                                  user, so the new code's db:migrate runs before any
#                                                  process can start on that code
#   4 swap: $APP -> $APP.prev, $STAGE -> $APP      two renames, then at once
#   5 the migrate unit again (applies nothing), restart the API, health
#   6 green: record, remove $APP.prev.  Red: swap back, restart the old tree, check it, exit 1
#
# A failure in 1-3 removes $STAGE and leaves $APP at $current with nothing restarted. Migrations are
# forward-only (above), so a failure in 3 can leave some of them applied under the old code: they are
# additive by this repository's rule, and the ledger says which.
deploy_staged() { # full sha, rollback yes|no, current sha
  local full="$1" rollback="$2" current="$3"
  local parent stage prevtree failed untouched rc=0
  parent=$(dirname "$APP")
  stage="$parent/.stage-${full:0:12}"
  prevtree="$APP.prev"
  failed="$APP.failed"
  untouched="$APP is untouched at ${current:0:12} and $API_UNIT was not restarted"
  stage_fail() { rm -rf "$stage"; die "$1. $untouched"; }

  rm -rf "$stage" "$failed"
  require_free_disk "$parent"
  say "staging $full in $stage ($API_UNIT keeps running ${current:0:12} from $APP)"
  mkdir -p "$stage"
  [ "$(id -u)" != 0 ] || chown "$RUN_USER:" "$stage"
  # --local hard-links the object store, so this costs seconds and almost no disk. The old tree's own
  # git config (its origin, and any credential setting the box was given) comes across whole, so the
  # next `git fetch` in $APP behaves exactly as it did.
  as_user git clone --quiet --local --no-checkout "$APP" "$stage" || stage_fail "could not clone $APP"
  as_user cp "$APP/.git/config" "$stage/.git/config" || stage_fail "could not carry $APP/.git/config"
  as_user git -C "$stage" checkout --quiet --detach "$full" || stage_fail "could not check out $full in the stage"

  say "installing dependencies (in the stage)"
  pn -C "$stage" install --frozen-lockfile >/dev/null || stage_fail "pnpm install failed in the stage"

  say "build (in the stage)"
  build_in "$stage" || rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$rc" -eq 137 ] && echo "exit 137 is SIGKILL: most likely out of memory, see dmesg" >&2
    stage_fail "build failed (exit $rc). No migration ran"
  fi

  say "migrations, from the stage (with $ENVFILE, as $RUN_USER)"
  [ -f "$ENVFILE" ] || stage_fail "no $ENVFILE"
  systemd-run --quiet --wait --pipe --collect --unit="rawprod-stage-migrate-$$" \
    -p User="$RUN_USER" -p WorkingDirectory="$stage" -p EnvironmentFile="$ENVFILE" \
    --setenv=PATH="$TOOL_PATH" --setenv=COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "$PNPM" db:migrate || stage_fail "migrations failed (a block that committed before the failure stays; public.schema_migrations says which)"

  # What lived in the old tree and is not in the commit is NOT carried across: the new tree is the
  # commit plus its install. Said, so a file someone placed by hand is not lost silently.
  local left
  left=$(as_user git -C "$APP" status --porcelain --ignored --untracked-files=normal 2>/dev/null \
    | grep -E '^(\?\?|!!) ' | cut -c4- \
    | grep -vE '(^|/)(node_modules|dist|\.next|\.turbo|coverage|test-results)/|\.tsbuildinfo$' | head -20 || true)
  [ -z "$left" ] || { say "not carried to the new tree (untracked in $APP):"; printf '%s\n' "$left" | sed 's/^/      /'; }

  say "swapping $APP to $full"
  rm -rf "$prevtree"
  mv "$APP" "$prevtree" || stage_fail "could not move $APP aside"
  if ! mv "$stage" "$APP"; then
    mv "$prevtree" "$APP"
    stage_fail "could not move the stage into place; $APP was put back"
  fi

  swap_back() { # why
    echo "$1. Putting ${current:0:12} back." >&2
    rm -rf "$failed"; mv "$APP" "$failed" && mv "$prevtree" "$APP"
    systemctl restart "$API_UNIT"; sleep 8
    if health; then
      echo "RETURNED TO ${current:0:12}: $API_UNIT runs it again and answers. $full is kept in $failed for reading." >&2
    else
      echo "RETURNED TO ${current:0:12}, BUT IT DOES NOT ANSWER EITHER. See journalctl -u $API_UNIT." >&2
    fi
    exit 1
  }

  say "migrations ($MIGRATE_UNIT): applies nothing now, and is active again for the units that need it"
  systemctl restart "$MIGRATE_UNIT" || true
  systemctl is-active --quiet "$MIGRATE_UNIT" || swap_back "$MIGRATE_UNIT failed after the swap"

  say "restarting $API_UNIT"
  systemctl restart "$API_UNIT" || true
  sleep 8
  say "health"
  if health; then
    record_green "$full" "$rollback"
    rm -rf "$prevtree"
  else
    swap_back "HEALTH CHECK FAILED on $full"
  fi
}

case "${1:-}" in
  --version)  version ;;
  --status)   status ;;
  --rollback)
    take_host_lock
    # SHIP-RP (wrapper version 3). A deploy that died after the checkout (a failed build, failed
    # migrations, a failed health check) leaves DEPLOYED_SHA naming the commit that last passed health,
    # and that is where a rollback belongs. previous-sha is one release further back: going there
    # skipped the last good commit. Alembic's ops/deploy/deploy-sha.sh learned the same on 2026-11-07.
    target=$(cat "$PREV" 2>/dev/null || true)
    if [ -s "$STATE" ] && [ "$(cat "$STATE")" != "$(sudo -u rawprod git -C "$APP" rev-parse HEAD 2>/dev/null)" ]; then
      target=$(cat "$STATE")
    fi
    [ -n "$target" ] || die "no previous SHA recorded"
    say "rolling back to $target"
    deploy "$target" yes
    ;;
  "")         die "usage: $0 <sha> | --rollback | --status | --version   (RAWPROD_ROLE=main|vault)" ;;
  -*)         die "unknown option $1" ;;
  *)          take_host_lock; deploy "$1" no ;;
esac
