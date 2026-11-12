#!/usr/bin/env bash
# SHIP-RP: one command from a pushed RawProd commit to production, with the checks that protect the data.
#
#   infra/aws/ship.sh <sha> [--role main|vault] [--apply]
#
# Run on the operator's laptop. WITHOUT --apply it is a dry run: every local step runs for real, and each
# thing it would do to production is printed as "WOULD RUN" and not done. With --apply it deploys.
#
# Until this script a RawProd deploy was a person typing into an SSM session: fetch, deploy.sh, then
# remember install-static.sh for the consoles, with no backup first and nothing written down afterwards.
# The steps are the plan's (Alembic docs/plan/program/fast-deploy-and-new-host.md, 1.4):
#
#   (a) pushed commit      the commit is on origin (the box can fetch it), descends from what production
#                          runs, and is built in a fresh worktree: the verdict is about a commit
#   (b) build              pnpm install --frozen-lockfile, pnpm typecheck, and the build the box runs
#   (c) touched tests      scripts/touched-tests.mjs: the always-on contract tests plus the tests the
#                          change touches; the whole suite when a sensitive path changed
#   (d) migrations forward a throwaway local PostgreSQL: the DEPLOYED commit's db:migrate and db:seed,
#                          then this commit's db:migrate (twice: the second run must apply nothing),
#                          then db:validate. Runs when a migration or a table definition changed
#   (e) backup             main: infra/aws/backup/rawprod-backup.sh on the box, then the object is read
#                          back from S3 here. vault: RDS point-in-time recovery must be under 15 min old
#   (f) deploy             the commit's OWN infra/aws/deploy.sh, installed on the box and compared by
#                          sha256, run with RAWPROD_ROLE. Then, on main, install-static.sh prod: deploy.sh
#                          does not publish the consoles, so a web change used to need a second step
#   (g) health             DEPLOYED_SHA on the box equals the commit; /health answers 200 from outside on
#                          rawfactory, rawplatform and rawvault
#   evidence               ~/.rawprod/ship-evidence/<sha>/<stamp>-<role>-<mode>/ship.json, sealed, with a
#                          log per gate. Written on every exit, a failure included
#
# deploy.sh stays the only deployment implementation: this script never restarts a unit, never checks
# anything out on the box and never builds there. It sequences, and it refuses.
#
# ── ONE DEPLOY PER HOST ──────────────────────────────────────────────────────────────────────────────
# The main box has 3.8 GB and no swap. On 2026-11-07 a RawProd build and an Alembic build ran on it
# together, the kernel killed Alembic's, and the storefront was down for ten minutes. Two locks, both on
# the box, both read over SSM before anything else is sent:
#
#   /run/lock/raw-host-deploy.lock   the kernel flock deploy.sh and Alembic's ops/deploy/deploy-sha.sh
#                                    hold for as long as a deploy process lives. Held = a build is
#                                    running right now. ship.sh only probes it; the wrappers take it.
#   /run/lock/raw-host-ship.lock     NEW. One line: system=, role=, sha=, started=, by=. Created with
#                                    O_EXCL (noclobber) before the backup and removed after the health
#                                    check, so it covers the whole sequence and not just the build. A
#                                    ship of either system that finds it refuses and prints the line.
#                                    Under /run, so a reboot clears it; a ship that died leaves it, and
#                                    `ship.sh --unlock` removes it once no deploy holds the flock.
#
# Alembic's ops/scripts/ship.sh takes the same file with system=alembic. The vault box is another host
# with its own /run, so `--role vault` locks there and does not block a deploy on the main box.
#
# ── OTHER OPTIONS ────────────────────────────────────────────────────────────────────────────────────
#   --base <sha>          what production runs, when it is already known. Without it ship.sh reads
#                         /srv/rawprod/DEPLOYED_SHA over SSM (one read-only command)
#   --offline             make no AWS call at all. Dry run only, and needs --base
#   --tests '<glob>'      add test files by hand (repeatable)
#   --force-migrations    run step (d) even though no migration changed
#   --reprove             do not reuse an earlier proof of this commit; run (a) to (d) again
#   --allow-row-loss      step (d): accept a migration after which a seeded table holds fewer rows
#   --unlock              remove a stale /run/lock/raw-host-ship.lock (with --apply; refuses while a
#                         deploy holds the flock)
set -euo pipefail

SHIP_VERSION=1
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"
TOOLS=$(cd "$HERE/../.." && pwd)                      # the checkout this script, the rule and the list come from
REPO="${SHIP_REPO:-$TOOLS}"                           # the clone the commit is taken from

MAIN_INSTANCE="${RAWPROD_MAIN_INSTANCE:-i-04e7dc4e5edcc1ff7}"
VAULT_INSTANCE="${RAWPROD_VAULT_INSTANCE:-i-0edad222a96eeed07}"
PROFILE="${AWS_PROFILE:-rawaroma}"
REGION="${AWS_REGION:-us-west-2}"
: "${AWS_USE_DUALSTACK_ENDPOINT:=true}"
export AWS_USE_DUALSTACK_ENDPOINT
BUCKET="${RAWPROD_BACKUP_BUCKET:-alembic-backups-859485559854-usw2}"
VAULT_DB_INSTANCE="${RAWPROD_VAULT_DB_INSTANCE:-vault-pg}"
VAULT_PITR_MAX_AGE_S="${RAWPROD_VAULT_PITR_MAX_AGE_S:-900}"
FACTORY_HOST="${RAWPROD_FACTORY_HOST:-rawfactory.huecycle.in}"
PLATFORM_HOST="${RAWPROD_PLATFORM_HOST:-rawplatform.huecycle.in}"
VAULT_HOST="${RAWPROD_VAULT_HOST:-rawvault.huecycle.in}"
EVIDENCE_ROOT="${RAWPROD_SHIP_EVIDENCE:-$HOME/.rawprod/ship-evidence}"
# PostGIS is installed on this laptop for PostgreSQL 17 only, and 0000_prerequisites.sql creates it, so
# the rehearsal runs on 17 while production is 16.15. Stated in the evidence, not hidden.
PG_BIN="${SHIP_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PG_PORT="${SHIP_PG_PORT:-5417}"
MIN_FREE_GB="${SHIP_MIN_FREE_GB:-10}"
MIN_BUILD_MEM_MB=1800                                 # deploy.sh's floor on the main box
SHIP_LOCK=/run/lock/raw-host-ship.lock
DEPLOY_LOCK=/run/lock/raw-host-deploy.lock

ROLE=main; APPLY=0; SHA_ARG=""; BASE_ARG=""; OFFLINE=0; FORCE_MIG=0; REPROVE=0; UNLOCK=0; ALLOW_ROW_LOSS=0
EXTRA_TESTS=()

usage() { sed -n '2,6p;/^# ── OTHER OPTIONS/,/^set -euo/p' "$SELF" | sed -e '$d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --role) ROLE="${2:-}"; shift ;;
    --base) BASE_ARG="${2:-}"; shift ;;
    --tests) EXTRA_TESTS+=("${2:-}"); shift ;;
    --offline) OFFLINE=1 ;;
    --force-migrations) FORCE_MIG=1 ;;
    --reprove) REPROVE=1 ;;
    --allow-row-loss) ALLOW_ROW_LOSS=1 ;;
    --unlock) UNLOCK=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "FATAL: unknown option $1" >&2; exit 2 ;;
    *) [ -z "$SHA_ARG" ] || { echo "FATAL: one commit at a time (got $SHA_ARG and $1)" >&2; exit 2; }; SHA_ARG="$1" ;;
  esac
  shift
done

case "$ROLE" in main) INSTANCE="$MAIN_INSTANCE" ;; vault) INSTANCE="$VAULT_INSTANCE" ;; *) echo "FATAL: --role is main or vault" >&2; exit 2 ;; esac
[ "$UNLOCK" = 1 ] || [ -n "$SHA_ARG" ] || { usage >&2; exit 2; }
if [ "$OFFLINE" = 1 ]; then
  [ "$APPLY" = 0 ] || { echo "FATAL: --offline makes no AWS call, so it cannot --apply" >&2; exit 2; }
  [ "$UNLOCK" = 0 ] || { echo "FATAL: --unlock reads the box, so it cannot be --offline" >&2; exit 2; }
  [ -n "$BASE_ARG" ] || { echo "FATAL: --offline cannot read what production runs; name it with --base <sha>" >&2; exit 2; }
fi

MODE=$([ "$APPLY" = 1 ] && echo apply || echo dry-run)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STARTED=$(date -u +%FT%TZ)
START_EPOCH=$(date +%s)
BY=$(printf '%s@%s' "$(id -un)" "$(hostname -s 2>/dev/null || echo laptop)" | tr -c 'A-Za-z0-9._@-' '_')
TMP_ROOT="${TMPDIR:-/tmp}"
WORK=$(mktemp -d "${TMP_ROOT%/}/rawprod-ship.XXXXXX")
LOGS="$WORK/logs"; mkdir -p "$LOGS"
: > "$WORK/gates.tsv"; : > "$WORK/notes"; : > "$WORK/meta"

STAGE=preflight        # preflight | local | lock | backup | deploy | static | health | done
VERDICT=""
FULL=""; BASE=""; SHORT=""
PG_PID=""; PGDATA=""
LOCK_LINE=""; LOCK_TAKEN=0
HEAD_WT=""; BASE_WT=""
GATE_N=1
SSM_N=0
SSM_OUT=""

say()  { echo "==> $*"; }
note() { echo "    $*"; printf '%s\n' "$*" >> "$WORK/notes"; }
meta() { printf '%s=%s\n' "$1" "$2" >> "$WORK/meta"; }
gate() { # name status seconds detail
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >> "$WORK/gates.tsv"
  printf '  %-8s %-22s %5ss  %s\n' "$2" "$1" "$3" "${4:-}"
}
die() {
  echo >&2
  echo "FATAL: $*" >&2
  [ -n "$VERDICT" ] || VERDICT="FAILED at $STAGE: $*"
  exit 1
}

# Run one gate: output to its own log, a failure stops the ship and prints the end of the log.
run_gate() { # name, detail, command...
  local name="$1" detail="$2"; shift 2
  local log t0=$SECONDS rc=0
  log="$LOGS/$(printf '%02d' "$GATE_N")-$(printf '%s' "$name" | tr ' ' '-').log"; GATE_N=$((GATE_N + 1))
  # A subshell with its own `set -e`, and not `cmd || rc=$?`: bash switches errexit off inside a function
  # called on the left of ||, and a gate whose third command failed would run on to its fourth.
  set +e
  ( set -e; "$@" ) > "$log" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    gate "$name" FAILED "$((SECONDS - t0))" "exit $rc"
    tail -30 "$log" | sed 's/^/        /' >&2
    die "$name failed (exit $rc). Full output: $(evidence_path "$log")"
  fi
  gate "$name" ok "$((SECONDS - t0))" "$detail"
}
evidence_path() { # where a work-directory file will be once the evidence is written
  [ -n "$FULL" ] && echo "$EVIDENCE_ROOT/$FULL/$STAMP-$ROLE-$MODE/${1#"$WORK"/}" || echo "$1"
}

# ── SSM ──────────────────────────────────────────────────────────────────────────────────────────────
# Every command sent to a box goes through ssm_read (read-only, both modes) or ssm_apply (changes
# something: sent only with --apply, printed as WOULD RUN otherwise). Nothing else calls ssm_send.
ssm_send() { # kind, timeout seconds; the script on stdin. Output in SSM_OUT. Non-zero unless Success.
  local kind="$1" timeout="$2" script blob id st
  script=$(cat)
  blob=$(printf '%s\n' "$script" | base64 | tr -d '\n')
  SSM_N=$((SSM_N + 1))
  node -e '
    const [inst, kind, timeout, blob] = process.argv.slice(1);
    // One sh line: the script travels as base64 and runs under bash, so the box never re-quotes it.
    const line = `f=$(mktemp) && echo ${blob} | base64 -d > "$f" && bash "$f"; rc=$?; rm -f "$f"; exit $rc`;
    process.stdout.write(JSON.stringify({ InstanceIds: [inst], DocumentName: "AWS-RunShellScript", Comment: `rawprod-ship:${kind}`,
      TimeoutSeconds: 120, Parameters: { commands: [line], executionTimeout: [String(timeout)] } }));
  ' "$INSTANCE" "$kind" "$timeout" "$blob" > "$WORK/ssm-$SSM_N.json"
  id=$(aws ssm send-command --profile "$PROFILE" --region "$REGION" --cli-input-json "file://$WORK/ssm-$SSM_N.json" \
        --query Command.CommandId --output text) || { SSM_OUT=""; return 1; }
  local waited=0
  while :; do
    st=$(aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" --command-id "$id" --instance-id "$INSTANCE" \
          --query Status --output text 2>/dev/null || echo Pending)
    case "$st" in
      Pending|InProgress|Delayed) sleep "${SHIP_SSM_POLL_S:-5}"; waited=$((waited + 5))
        [ "$waited" -le $((timeout + 180)) ] || { st=TimedOutWaiting; break; } ;;
      *) break ;;
    esac
  done
  SSM_OUT=$(aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" --command-id "$id" --instance-id "$INSTANCE" \
            --query StandardOutputContent --output text 2>/dev/null || true)
  printf '%s\n' "$SSM_OUT" > "$LOGS/ssm-$SSM_N-$kind.out"
  if [ "$st" != Success ]; then
    aws ssm get-command-invocation --profile "$PROFILE" --region "$REGION" --command-id "$id" --instance-id "$INSTANCE" \
      --query StandardErrorContent --output text 2>/dev/null | tail -20 > "$LOGS/ssm-$SSM_N-$kind.err" || true
    echo "    SSM command $id ($kind) on $INSTANCE finished: $st" >&2
    return 1
  fi
}
ssm_read() { ssm_send "$@"; }
ssm_apply() { # kind, timeout, what it does in words; script on stdin
  local kind="$1" timeout="$2" what="$3"
  if [ "$APPLY" = 0 ]; then
    cat > /dev/null
    echo "    WOULD RUN on $INSTANCE: $what"
    return 0
  fi
  ssm_send "$kind" "$timeout"
}
kv() { printf '%s\n' "$SSM_OUT" | sed -n "s/^$1=//p" | head -1; }

# The scripts that run on the box. Laptop values go in as quoted assignments at the top; the body is a
# quoted heredoc, so nothing in it is expanded here.
remote_head() {
  printf 'set -euo pipefail\n'
  printf 'SHA=%q\nROLE=%q\nLOCK_LINE=%q\nSHIP_LOCK=%q\nDEPLOY_LOCK=%q\n' "$FULL" "$ROLE" "$LOCK_LINE" "$SHIP_LOCK" "$DEPLOY_LOCK"
  printf 'WANT_DEPLOY_SHA256=%q\nVERDICT=%q\nBY=%q\nSTAMP=%q\n' "${DEPLOY_SHA256:-}" "$(printf '%s' "${VERDICT:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-240)" "$BY" "$STAMP"
}
remote_status() { remote_head; cat <<'REMOTE'
echo "deployed=$(cat /srv/rawprod/DEPLOYED_SHA 2>/dev/null || echo unrecorded)"
echo "previous=$(cat /etc/rawprod/previous-sha 2>/dev/null || echo none)"
echo "checkout=$(sudo -u rawprod git -C /srv/rawprod/app rev-parse HEAD 2>/dev/null || echo unknown)"
echo "mem_available_mb=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
echo "ship_lock=$(cat "$SHIP_LOCK" 2>/dev/null || echo free)"
if command -v flock >/dev/null 2>&1; then
  if flock -n "$DEPLOY_LOCK" true 2>/dev/null; then echo "deploy_flock=free"
  else echo "deploy_flock=held by $(tail -1 "$DEPLOY_LOCK" 2>/dev/null || echo unknown)"; fi
else
  echo "deploy_flock=unknown (no flock on this host)"
fi
REMOTE
}
remote_lock_take() { remote_head; cat <<'REMOTE'
command -v flock >/dev/null 2>&1 || { echo "REFUSED: no flock on this host, so a running deploy cannot be seen"; exit 75; }
flock -n "$DEPLOY_LOCK" true || { echo "REFUSED: a deploy holds the host lock: $(tail -1 "$DEPLOY_LOCK" 2>/dev/null)"; exit 75; }
# noclobber is O_EXCL: of two ships that get here together, exactly one creates the file.
if ! ( set -o noclobber; printf '%s\n' "$LOCK_LINE" > "$SHIP_LOCK" ) 2>/dev/null; then
  echo "REFUSED: the ship lock is held: $(cat "$SHIP_LOCK" 2>/dev/null)"; exit 75
fi
echo "locked=$LOCK_LINE"
REMOTE
}
remote_lock_release() { remote_head; cat <<'REMOTE'
# Only our own line: a lock somebody else took after ours was cleared by hand is theirs.
if [ "$(cat "$SHIP_LOCK" 2>/dev/null)" = "$LOCK_LINE" ]; then rm -f "$SHIP_LOCK"; echo "released=yes"; else echo "released=not-ours"; fi
mkdir -p /etc/rawprod
printf '{"at":"%s","stamp":"%s","sha":"%s","role":"%s","by":"%s","verdict":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$STAMP" "$SHA" "$ROLE" "$BY" "$VERDICT" >> /etc/rawprod/ship-log.jsonl
REMOTE
}
remote_unlock() { remote_head; cat <<'REMOTE'
[ -e "$SHIP_LOCK" ] || { echo "unlocked=nothing-to-remove"; exit 0; }
flock -n "$DEPLOY_LOCK" true || { echo "REFUSED: a deploy holds the host lock right now: $(tail -1 "$DEPLOY_LOCK" 2>/dev/null)"; exit 75; }
echo "removed=$(cat "$SHIP_LOCK")"
rm -f "$SHIP_LOCK"
REMOTE
}
remote_backup() { remote_head
  printf 'BACKUP_B64=%q\nWANT_BACKUP_SHA256=%q\n' "$(base64 < "$TOOLS/infra/aws/backup/rawprod-backup.sh" | tr -d '\n')" "$(sha256_of "$TOOLS/infra/aws/backup/rawprod-backup.sh")"
  cat <<'REMOTE'
install -d -m 755 /usr/local/lib/rawaroma
tmp=$(mktemp)
printf '%s' "$BACKUP_B64" | base64 -d > "$tmp"
got=$(sha256sum "$tmp" | cut -d' ' -f1)
[ "$got" = "$WANT_BACKUP_SHA256" ] || { rm -f "$tmp"; echo "REFUSED: the backup script arrived as $got, not $WANT_BACKUP_SHA256"; exit 1; }
install -m 755 -o root -g root "$tmp" /usr/local/lib/rawaroma/rawprod-backup.sh; rm -f "$tmp"
/usr/local/lib/rawaroma/rawprod-backup.sh
REMOTE
}
remote_deploy() { remote_head; cat <<'REMOTE'
APP=/srv/rawprod/app
install -d -m 750 /var/log/rawprod-ship
LOG=/var/log/rawprod-ship/$STAMP-${SHA:0:8}-$ROLE.log
sudo -u rawprod git -C "$APP" fetch --all --tags --prune --quiet
# The commit's OWN wrapper, never the one in the checkout: the checkout is still at the old commit, and
# an old wrapper has run a build the vault box cannot hold (DEPLOY_AWS.md section 7).
tmp=$(mktemp)
sudo -u rawprod git -C "$APP" show "$SHA:infra/aws/deploy.sh" > "$tmp"
got=$(sha256sum "$tmp" | cut -d' ' -f1)
[ "$got" = "$WANT_DEPLOY_SHA256" ] || { rm -f "$tmp"; echo "REFUSED: deploy.sh at $SHA on the box is $got, the laptop has $WANT_DEPLOY_SHA256"; exit 1; }
install -m 755 -o root -g root "$tmp" /usr/local/sbin/rawprod-deploy; rm -f "$tmp"
echo "wrapper=$got"
rc=0
RAWPROD_ROLE="$ROLE" /usr/local/sbin/rawprod-deploy "$SHA" > "$LOG" 2>&1 || rc=$?
# SSM returns the FIRST 24,000 characters; a build prints more. The end is what says how it went.
tail -40 "$LOG"
echo "log=$LOG"
echo "deploy_exit=$rc"
exit "$rc"
REMOTE
}
remote_static() { remote_head; cat <<'REMOTE'
APP=/srv/rawprod/app
# Only after deploy.sh's own health check passed: it writes DEPLOYED_SHA last, and only when green.
[ "$(cat /srv/rawprod/DEPLOYED_SHA 2>/dev/null)" = "$SHA" ] || { echo "REFUSED: DEPLOYED_SHA is not $SHA, so the consoles are not published"; exit 1; }
[ "$(sudo -u rawprod git -C "$APP" rev-parse HEAD)" = "$SHA" ] || { echo "REFUSED: $APP is not at $SHA"; exit 1; }
bash "$APP/infra/aws/nginx/install-static.sh" prod
REMOTE
}

sha256_of() { local s; s=$( (command -v sha256sum >/dev/null 2>&1 && sha256sum "$1") || shasum -a 256 "$1" ); echo "${s%% *}"; }

# ── the throwaway PostgreSQL ─────────────────────────────────────────────────────────────────────────
pg_url() { echo "postgres://ship@127.0.0.1:$PG_PORT/$1"; }
pg_sql() { "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U ship -d "${2:-postgres}" -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
pg_start() {
  [ -z "$PG_PID" ] || return 0
  # A listener this run did not start is somebody else's cluster. Never adopt it, never stop it.
  if (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; then
    die "port $PG_PORT is already listening and this run did not start it. Set SHIP_PG_PORT to a free port"
  fi
  PGDATA="$WORK/pg"
  "$PG_BIN/initdb" -D "$PGDATA" -U ship --auth=trust -E UTF8 --locale=en_US.UTF-8 > "$LOGS/pg-initdb.log" 2>&1 \
    || die "initdb failed: $(tail -3 "$LOGS/pg-initdb.log")"
  # TCP on loopback only; no unix socket (the temp path is too long for one on macOS). fsync off: the
  # cluster is deleted in a few minutes whatever happens to it.
  "$PG_BIN/pg_ctl" -D "$PGDATA" -w -t 60 -l "$LOGS/postgres.log" \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c max_connections=60" start \
    > "$LOGS/pg-start.log" 2>&1 || die "the throwaway PostgreSQL did not start: $(tail -3 "$LOGS/postgres.log" 2>/dev/null)"
  PG_PID=$(head -1 "$PGDATA/postmaster.pid")
  meta scratch_postgres "$("$PG_BIN/postgres" --version 2>/dev/null || echo unknown) on 127.0.0.1:$PG_PORT (production is 16.15)"
}
pg_stop() { # by PID, on every exit path
  [ -n "$PG_PID" ] || return 0
  "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate -w -t 30 stop > /dev/null 2>&1 || kill "$PG_PID" 2>/dev/null || true
  PG_PID=""
}

# ── the end of every run ─────────────────────────────────────────────────────────────────────────────
finish() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  pg_stop
  if [ -z "$VERDICT" ]; then VERDICT="FAILED at $STAGE (exit $rc)"; fi
  if [ "$LOCK_TAKEN" = 1 ]; then
    if ssm_send lock-release 60 <<< "$(remote_lock_release)"; then echo "==> ship lock released on $INSTANCE"; LOCK_TAKEN=0
    else
      echo "!!  THE SHIP LOCK IS STILL HELD on $INSTANCE: $LOCK_LINE" >&2
      echo "!!  Clear it with: infra/aws/ship.sh --unlock --role $ROLE --apply" >&2
      printf '%s\n' "ship lock NOT released: $LOCK_LINE" >> "$WORK/notes"
    fi
  fi
  # Worktrees: removed when the run passed, kept for reading when it did not.
  local wt keep=0
  case "$VERDICT" in FAILED*|DEPLOYED\ BUT*) keep=1 ;; esac
  for wt in "$HEAD_WT" "$BASE_WT"; do
    [ -n "$wt" ] && [ -d "$wt" ] || continue
    if [ "$keep" = 1 ] && [ "$STAGE" = local ]; then echo "    kept for reading: $wt (remove with: git -C $REPO worktree remove --force $wt)"
    else git -C "$REPO" worktree remove --force "$wt" > /dev/null 2>&1; fi
  done
  git -C "$REPO" worktree prune > /dev/null 2>&1
  meta finished "$(date -u +%FT%TZ)"
  meta seconds "$(( $(date +%s) - START_EPOCH ))"
  meta verdict "$VERDICT"
  local out=""
  if [ -n "$FULL" ]; then
    out="$EVIDENCE_ROOT/$FULL/$STAMP-$ROLE-$MODE"
    mkdir -p "$out" && cp -R "$LOGS" "$out/" 2>/dev/null
    node "$TOOLS/infra/aws/ship-evidence.mjs" write --work "$WORK" --out "$out/ship.json" || out=""
  fi
  rm -rf "$PGDATA" 2>/dev/null
  if [ "$keep" = 0 ] || [ "$STAGE" != local ]; then rm -rf "$WORK"; fi
  echo
  echo "VERDICT: $VERDICT"
  if [ -n "$out" ]; then echo "evidence: $out/ship.json"; else echo "evidence: none written (the commit was never resolved)"; fi
  exit "$rc"
}
trap finish EXIT
trap 'VERDICT="${VERDICT:-FAILED at $STAGE: interrupted}"; exit 130' INT TERM

# ── preflight: seconds, before minutes ───────────────────────────────────────────────────────────────
say "ship RawProd ($ROLE, $MODE)"
command -v git >/dev/null 2>&1 || die "no git on PATH"
command -v node >/dev/null 2>&1 || die "no node on PATH. Node 22: export PATH=\$HOME/.nvm/versions/node/v22.22.2/bin:\$PATH"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" = 22 ] || die "node is $(node -v), and the box runs 22. export PATH=\$HOME/.nvm/versions/node/v22.22.2/bin:\$PATH"
command -v pnpm >/dev/null 2>&1 || die "no pnpm on PATH"
[ "$OFFLINE" = 1 ] || command -v aws >/dev/null 2>&1 || die "no aws CLI on PATH (or run a dry run with --offline --base <sha>)"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO is not a git checkout"
TOOL_SHA256=$(sha256_of "$SELF")
meta ship_sh_version "$SHIP_VERSION"
meta ship_sh_sha256 "$TOOL_SHA256"
meta tools_commit "$(git -C "$TOOLS" rev-parse HEAD 2>/dev/null || echo unknown)"
meta role "$ROLE"; meta mode "$MODE"; meta started "$STARTED"; meta operator "$BY"; meta instance "$INSTANCE"

# ── --unlock: the manual override for a ship that died holding the lock ──────────────────────────────
if [ "$UNLOCK" = 1 ]; then
  STAGE=lock
  ssm_read status 60 <<< "$(remote_status)" || die "could not read $INSTANCE over SSM"
  held=$(kv ship_lock); flock_state=$(kv deploy_flock)
  echo "    ship lock on $INSTANCE : $held"
  echo "    deploy flock          : $flock_state"
  if [ "$held" = free ]; then VERDICT="NOTHING TO UNLOCK"; STAGE=done; exit 0; fi
  [ "$flock_state" = free ] || die "a deploy is running on $INSTANCE ($flock_state). The lock is not stale; wait for it"
  ssm_apply unlock 60 "remove $SHIP_LOCK ($held)" <<< "$(remote_unlock)" || die "the unlock was refused: $SSM_OUT"
  [ "$APPLY" = 1 ] && { echo "    $SSM_OUT"; VERDICT="UNLOCKED"; } || VERDICT="DRY RUN: would remove the ship lock"
  STAGE=done; exit 0
fi

FREE_GB=$(df -Pk / | awk 'NR==2 {print int($4/1048576)}')
[ "$FREE_GB" -ge "$MIN_FREE_GB" ] || die "only ${FREE_GB} GB free on /, and a ship builds and starts a database: ${MIN_FREE_GB} GB needed. Clean up first"

# ── (a) a pushed commit ──────────────────────────────────────────────────────────────────────────────
STAGE=local
T0=$SECONDS
git -C "$REPO" fetch --quiet --prune origin || die "git fetch origin failed, so 'pushed' cannot be checked"
FULL=$(git -C "$REPO" rev-parse --verify --quiet "${SHA_ARG}^{commit}") || die "commit $SHA_ARG is not in $REPO"
SHORT=${FULL:0:8}
meta sha "$FULL"
ON_ORIGIN=$(git -C "$REPO" branch -r --contains "$FULL" 2>/dev/null | sed 's/^ *//' | grep '^origin/' | grep -v ' -> ' | head -3 | tr '\n' ' ' || true)
[ -n "$ON_ORIGIN" ] || die "commit $SHORT is on no branch of origin, so the box cannot fetch it. Push it first: git push origin $FULL:refs/heads/<branch>"

# What production runs. One read-only SSM command, which also reads both locks.
STATUS_READ=0
if [ "$OFFLINE" = 0 ]; then
  ssm_read status 60 <<< "$(remote_status)" || die "could not read $INSTANCE over SSM (profile $PROFILE, region $REGION). The agent is the only way in"
  STATUS_READ=1
  DEPLOYED=$(kv deployed); HOST_FLOCK=$(kv deploy_flock); HOST_SHIP_LOCK=$(kv ship_lock); HOST_MEM=$(kv mem_available_mb)
  meta box_deployed "$DEPLOYED"; meta box_checkout "$(kv checkout)"; meta box_mem_available_mb "$HOST_MEM"
  LOCK_STATE=free
  [ "$HOST_FLOCK" = free ] || LOCK_STATE="a deploy is running on $INSTANCE right now ($HOST_FLOCK)"
  [ "$HOST_SHIP_LOCK" = free ] || LOCK_STATE="the ship lock on $INSTANCE is held: $HOST_SHIP_LOCK"
  if [ "$LOCK_STATE" != free ]; then
    gate "host lock" HELD 0 "$LOCK_STATE"
    if [ "$APPLY" = 1 ]; then
      die "REFUSED: $LOCK_STATE. One deploy per host: the box ran out of memory when two built together. If that ship is dead and no deploy is running: infra/aws/ship.sh --unlock --role $ROLE --apply"
    fi
    note "host lock: --apply would be REFUSED right now: $LOCK_STATE"
  else
    gate "host lock" ok 0 "free on $INSTANCE: no deploy running, no ship in progress"
  fi
  if [ "$ROLE" = main ] && [ -n "$HOST_MEM" ] && [ "$HOST_MEM" -lt "$MIN_BUILD_MEM_MB" ]; then
    note "memory: $INSTANCE has ${HOST_MEM} MB available and deploy.sh needs $MIN_BUILD_MEM_MB to build: the deploy would refuse"
  fi
  if [ -n "$BASE_ARG" ]; then
    BASE_GIVEN=$(git -C "$REPO" rev-parse --verify --quiet "${BASE_ARG}^{commit}") || die "--base $BASE_ARG is not in $REPO"
    [ "$BASE_GIVEN" = "$DEPLOYED" ] || die "--base says production runs ${BASE_GIVEN:0:8}, the box says ${DEPLOYED:0:8}. The box is right; drop --base"
  fi
  BASE_ARG="$DEPLOYED"
else
  gate "host lock" unread 0 "--offline: the box was not asked. --apply reads and takes the lock"
  note "offline: production was not read. The base is the operator's word (--base $BASE_ARG)"
fi
# Review focus 1 of the plan: a deployed commit this clone has never seen must refuse, not diff against nothing.
BASE=$(git -C "$REPO" rev-parse --verify --quiet "${BASE_ARG}^{commit}") \
  || die "production runs $BASE_ARG, and that commit is not in this clone even after a fetch. It was deployed from a branch that is not on origin; find it before shipping over it"
meta base "$BASE"
if [ "$BASE" != "$FULL" ] && ! git -C "$REPO" merge-base --is-ancestor "$BASE" "$FULL"; then
  die "commit $SHORT does not descend from what production runs (${BASE:0:8}). A forward deploy of it could run code against migrations it has never seen; deploy.sh checks that only for --rollback. Rebase onto ${BASE:0:8}, or roll back on the box with: RAWPROD_ROLE=$ROLE /usr/local/sbin/rawprod-deploy --rollback"
fi

# The wrapper this commit carries is the one that will run. It must be the kind that excludes Alembic.
git -C "$REPO" cat-file -e "$FULL:infra/aws/deploy.sh" 2>/dev/null || die "commit $SHORT has no infra/aws/deploy.sh"
git -C "$REPO" show "$FULL:infra/aws/deploy.sh" > "$WORK/deploy.sh"
grep -q "$DEPLOY_LOCK" "$WORK/deploy.sh" || die "deploy.sh at $SHORT does not take $DEPLOY_LOCK, so its build could run beside Alembic's. Ship a commit that has the host lock"
DEPLOY_SHA256=$(sha256_of "$WORK/deploy.sh")
meta deploy_sh_sha256 "$DEPLOY_SHA256"
if [ "$ROLE" = main ]; then
  git -C "$REPO" cat-file -e "$FULL:infra/aws/nginx/install-static.sh" 2>/dev/null || die "commit $SHORT has no infra/aws/nginx/install-static.sh, so the consoles could not be published"
fi
gate "pushed commit" ok "$((SECONDS - T0))" "$SHORT on ${ON_ORIGIN% }; production runs ${BASE:0:8}"

# ── one proof per commit ─────────────────────────────────────────────────────────────────────────────
PROOF=""
if [ "$REPROVE" = 0 ]; then
  PROOF=$(node "$TOOLS/infra/aws/ship-evidence.mjs" find-proof --dir "$EVIDENCE_ROOT/$FULL" --sha "$FULL" --base "$BASE" --role "$ROLE" --tool "$TOOL_SHA256" 2>/dev/null || true)
fi

if [ -n "$PROOF" ]; then
  gate "local proof" reused 0 "$PROOF"
  note "local proof reused from $PROOF: same commit, same base, same role, same ship.sh, under 24 h old. --reprove runs it again"
  meta local_proof "reused"
  meta local_proof_file "$PROOF"
else
  # ── (b) build, in a fresh worktree ─────────────────────────────────────────────────────────────────
  HEAD_WT="$WORK/head"
  git -C "$REPO" worktree add --quiet --detach "$HEAD_WT" "$FULL" > "$LOGS/worktree.log" 2>&1 || die "could not create a worktree at $SHORT: $(tail -2 "$LOGS/worktree.log")"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  run_gate install "pnpm install --frozen-lockfile" pnpm -C "$HEAD_WT" install --frozen-lockfile --prefer-offline
  run_gate typecheck "pnpm typecheck" pnpm -C "$HEAD_WT" typecheck
  # The build the box runs (deploy.sh, "build"), so a commit that cannot build fails here and not there.
  run_gate build "the box's serial build" pnpm -C "$HEAD_WT" -r --workspace-concurrency=1 --filter '!@core/admin-shell' --filter '!@core/api' build

  # ── (c) the tests the change touches ───────────────────────────────────────────────────────────────
  TT_ARGS=(--repo "$HEAD_WT" --base "$BASE" --head "$FULL" --always "$TOOLS/infra/aws/fast-proof-always.txt")
  for g in ${EXTRA_TESTS[@]+"${EXTRA_TESTS[@]}"}; do TT_ARGS+=(--tests "$g"); done
  tt_rc=0
  node "$TOOLS/scripts/touched-tests.mjs" "${TT_ARGS[@]}" > "$WORK/selection.json" 2> "$LOGS/touched-tests.err" || tt_rc=$?
  if [ "$tt_rc" -ne 0 ]; then
    node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for (const r of s.refusals||[]) console.error("    "+r)' "$WORK/selection.json" 2>/dev/null || true
    die "the test selection refused or failed (exit $tt_rc): $(cat "$LOGS/touched-tests.err")"
  fi
  SEL=$(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    require("fs").writeFileSync(process.argv[2], s.files.join("\n") + (s.files.length ? "\n" : ""));
    require("fs").appendFileSync(process.argv[3], s.notes.map((n) => n + "\n").join(""));
    console.log([s.files.length, s.fullSuite ? 1 : 0, s.migrations ? 1 : 0, s.changed].join(" "));
  ' "$WORK/selection.json" "$WORK/test-files" "$WORK/notes")
  read -r N_FILES FULL_SUITE MIGRATIONS N_CHANGED <<< "$SEL"
  NEED_DB=$([ "$FULL_SUITE" = 1 ] || [ "$MIGRATIONS" = 1 ] || [ "$FORCE_MIG" = 1 ] || [ "$N_FILES" -gt 0 ] && echo 1 || echo 0)
  if [ "$NEED_DB" = 1 ]; then
    [ -x "$PG_BIN/initdb" ] && [ -x "$PG_BIN/pg_ctl" ] && [ -x "$PG_BIN/psql" ] || die "no PostgreSQL at $PG_BIN (initdb, pg_ctl, psql). Set SHIP_PG_BIN"
    pg_start
    pg_sql "create database ship_tests"
  fi
  export TEST_DATABASE_URL; TEST_DATABASE_URL=$(pg_url ship_tests)
  if [ "$FULL_SUITE" = 1 ]; then
    run_gate "touched tests" "WHOLE SUITE (a sensitive path changed; $N_CHANGED files changed)" pnpm -C "$HEAD_WT" test
  elif [ "$N_FILES" -gt 0 ]; then
    # The runner's own flags (backend/test-support/run-tests.mjs): one file at a time on one database.
    run_tests() { ( cd "$HEAD_WT" && xargs node --import @swc-node/register/esm-register --test --test-concurrency=1 \
      "--test-timeout=${TEST_FILE_TIMEOUT_MS:-300000}" < "$WORK/test-files" ); }
    run_gate "touched tests" "$N_FILES files ($N_CHANGED files changed since ${BASE:0:8})" run_tests
  else
    gate "touched tests" skipped 0 "no test file selected (see notes)"
  fi

  # ── (d) migrations forward from what production runs ───────────────────────────────────────────────
  if [ "$MIGRATIONS" = 1 ] || [ "$FORCE_MIG" = 1 ]; then
    BASE_WT="$WORK/base"
    COUNTS="select n.nspname||'.'||c.relname||'|'||(xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema','tiger','tiger_data','topology') and n.nspname !~ '^pg_' and c.relname <> 'schema_migrations' order by 1"
    rehearse() {
      git -C "$REPO" worktree add --quiet --detach "$BASE_WT" "$BASE"
      pnpm -C "$BASE_WT" install --frozen-lockfile --prefer-offline
      pg_sql "create database ship_migrate"
      pg_sql "do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'ship_app') then create role ship_app login; end if; end \$\$"
      local url; url=$(pg_url ship_migrate)
      # The same shape each box's migrate unit has (infra/aws/env/render-env.sh): the main box never
      # sees the formula blocks, the vault box never sees main's.
      local -a menv
      if [ "$ROLE" = vault ]; then menv=(env -u DATABASE_URL "FORMULA_DATABASE_URL=$url" SKIP_TARGETS=main)
      else menv=(env -u FORMULA_DATABASE_URL "DATABASE_URL=$url" SKIP_TARGETS=formula DB_APP_ROLE=ship_app); fi
      echo "== the deployed commit ${BASE:0:8}: db:migrate =="
      ( cd "$BASE_WT" && "${menv[@]}" pnpm db:migrate )
      if [ "$ROLE" = main ]; then
        echo "== the deployed commit: db:seed (rows for the migration to meet) =="
        ( cd "$BASE_WT" && env "DATABASE_URL=$url" "BOOTSTRAP_OWNER_PASSWORD=$(node -p 'require("crypto").randomBytes(24).toString("hex")')" pnpm db:seed )
      fi
      pg_sql "select id from public.schema_migrations order by 1" ship_migrate > "$WORK/ledger.before"
      pg_sql "$COUNTS" ship_migrate > "$WORK/rows.before"
      echo "== this commit $SHORT: db:migrate =="
      ( cd "$HEAD_WT" && "${menv[@]}" pnpm db:migrate )
      pg_sql "select id from public.schema_migrations order by 1" ship_migrate > "$WORK/ledger.after"
      pg_sql "$COUNTS" ship_migrate > "$WORK/rows.after"
      local lost; lost=$(comm -23 "$WORK/ledger.before" "$WORK/ledger.after" | head -5)
      [ -z "$lost" ] || { echo "LEDGER ROWS LOST by the migration: $lost"; return 1; }
      echo "== this commit, again: a second db:migrate must apply nothing =="
      ( cd "$HEAD_WT" && "${menv[@]}" pnpm db:migrate ) > "$WORK/migrate.second" 2>&1 || { cat "$WORK/migrate.second"; return 1; }
      if grep -q '(applied)' "$WORK/migrate.second"; then grep '(applied)' -B1 "$WORK/migrate.second"; echo "NOT IDEMPOTENT: the second run applied a block"; return 1; fi
      # A table that had rows and now has fewer: the migration deletes data.
      awk -F'|' 'NR==FNR {b[$1]=$2; next} ($1 in b) && ($2+0 < b[$1]+0) {print $1": "b[$1]" rows before, "$2" after"; n++} END {exit (n>0)}' \
        "$WORK/rows.before" "$WORK/rows.after" > "$WORK/rows.lost" || {
          cat "$WORK/rows.lost"
          if [ "$ALLOW_ROW_LOSS" = 1 ]; then echo "accepted with --allow-row-loss"; else echo "ROWS LOST by the migration. If that is the intent: --allow-row-loss"; return 1; fi
        }
      awk -F'|' 'NR==FNR {b[$1]=1; next} {delete b[$1]} END {for (t in b) {print "TABLE GONE after the migration: "t; n++}; exit (n>0)}' \
        "$WORK/rows.before" "$WORK/rows.after" || { [ "$ALLOW_ROW_LOSS" = 1 ] || return 1; }
      echo "== db:validate =="
      ( cd "$HEAD_WT" && pnpm db:validate )
      echo "ledger rows: $(wc -l < "$WORK/ledger.before" | tr -d ' ') -> $(wc -l < "$WORK/ledger.after" | tr -d ' '); tables: $(wc -l < "$WORK/rows.before" | tr -d ' ') -> $(wc -l < "$WORK/rows.after" | tr -d ' ')"
    }
    run_gate "migrations forward" "from ${BASE:0:8} to $SHORT on a throwaway PostgreSQL ($ROLE shape)" rehearse
    note "migrations forward: ledger $(wc -l < "$WORK/ledger.before" | tr -d ' ') -> $(wc -l < "$WORK/ledger.after" | tr -d ' ') rows, tables $(wc -l < "$WORK/rows.before" | tr -d ' ') -> $(wc -l < "$WORK/rows.after" | tr -d ' '); rehearsed on $("$PG_BIN/postgres" --version 2>/dev/null | awk '{print $NF}'), production is 16.15"
  else
    gate "migrations forward" skipped 0 "no migration or table definition changed since ${BASE:0:8}"
  fi
  pg_stop

  # ── the tree a verdict was given about is the tree that was checked out ────────────────────────────
  DIRTY=$(git -C "$HEAD_WT" status --porcelain --untracked-files=no | head -5)
  [ -z "$DIRTY" ] || die "the build or the tests changed tracked files in the worktree, so the verdict is not about $SHORT: $DIRTY"
  gate "tree unchanged" ok 0 "no tracked file differs from $SHORT"
fi

# ── production ───────────────────────────────────────────────────────────────────────────────────────
say "production: $INSTANCE ($ROLE)"
LOCK_LINE="system=rawprod role=$ROLE sha=$FULL started=$STARTED by=$BY"
meta lock_line "$LOCK_LINE"

# The lock, taken atomically on the box. The read above was a courtesy; this is the exclusion.
STAGE=lock
T0=$SECONDS
if ssm_apply lock-take 60 "take the ship lock $SHIP_LOCK (refuses if a deploy or another ship holds the host)" <<< "$(remote_lock_take)"; then
  if [ "$APPLY" = 1 ]; then LOCK_TAKEN=1; gate "ship lock" ok "$((SECONDS - T0))" "$LOCK_LINE"; else gate "ship lock" would 0 "$SHIP_LOCK"; fi
else
  gate "ship lock" REFUSED "$((SECONDS - T0))" "$(printf '%s' "$SSM_OUT" | tail -1)"
  die "$(printf '%s' "$SSM_OUT" | tail -1). One deploy per host. Nothing on $INSTANCE was changed"
fi

# ── (e) backup ───────────────────────────────────────────────────────────────────────────────────────
STAGE=backup
T0=$SECONDS
if [ "$ROLE" = main ]; then
  if ssm_apply backup 900 "pg_dump -Fc of rawprod, pg_restore --list read-back, upload to s3://$BUCKET/rawprod/pg_dump/" <<< "$(remote_backup)"; then
    if [ "$APPLY" = 1 ]; then
      LINE=$(printf '%s\n' "$SSM_OUT" | grep '^rawprod-backup OK ' | tail -1 || true)
      [ -n "$LINE" ] || die "the backup step ended without its OK line. No deploy was started"
      B_KEY=$(sed -n 's/.* key=\([^ ]*\).*/\1/p' <<< "$LINE"); B_BYTES=$(sed -n 's/.* bytes=\([0-9]*\).*/\1/p' <<< "$LINE")
      # Read it back from here: the object exists, is the size the box said, and was written by THIS run
      # (the stamp in its key is not older than this ship; an object from last week's drill is not ours).
      S3_BYTES=$(aws s3api head-object --profile "$PROFILE" --region "$REGION" --bucket "$BUCKET" --key "$B_KEY" --query ContentLength --output text) \
        || die "s3://$BUCKET/$B_KEY cannot be read back. No deploy was started"
      [ "$S3_BYTES" = "$B_BYTES" ] || die "s3://$BUCKET/$B_KEY is $S3_BYTES bytes and the box dumped $B_BYTES. No deploy was started"
      B_STAMP=$(basename "$B_KEY" .dump)
      [ ! "$B_STAMP" \< "$STAMP" ] || die "the backup object $B_KEY is older than this ship ($STAMP). No deploy was started"
      meta backup "s3://$BUCKET/$B_KEY"; meta backup_line "$LINE"
      gate backup ok "$((SECONDS - T0))" "s3://$BUCKET/$B_KEY, $B_BYTES bytes, read back"
    else
      gate backup would 0 "rawprod-backup.sh on $INSTANCE, then head-object from here"
    fi
  else
    gate backup FAILED "$((SECONDS - T0))" "$(printf '%s' "$SSM_OUT" | tail -1)"
    die "the backup failed, so nothing was deployed: $(printf '%s' "$SSM_OUT" | tail -2)"
  fi
else
  if [ "$APPLY" = 1 ]; then
    LRT=$(aws rds describe-db-instances --profile "$PROFILE" --region "$REGION" --db-instance-identifier "$VAULT_DB_INSTANCE" \
          --query 'DBInstances[0].LatestRestorableTime' --output text) || die "cannot read $VAULT_DB_INSTANCE's latest restorable time. No deploy was started"
    AGE=$(node -p 'Math.round((Date.now() - Date.parse(process.argv[1])) / 1000)' "$LRT")
    case "$AGE" in ''|*[!0-9-]*) die "$VAULT_DB_INSTANCE's latest restorable time ($LRT) is not a time. No deploy was started" ;; esac
    [ "$AGE" -le "$VAULT_PITR_MAX_AGE_S" ] || die "$VAULT_DB_INSTANCE can be restored only to $LRT, ${AGE}s ago; the limit is ${VAULT_PITR_MAX_AGE_S}s. No deploy was started"
    meta backup "RDS point-in-time recovery of $VAULT_DB_INSTANCE, restorable to $LRT"
    gate backup ok "$((SECONDS - T0))" "$VAULT_DB_INSTANCE restorable to $LRT (${AGE}s ago)"
  else
    echo "    WOULD CHECK: $VAULT_DB_INSTANCE LatestRestorableTime is under ${VAULT_PITR_MAX_AGE_S}s old (the vault is not dumped; its restore point is RDS PITR)"
    gate backup would 0 "$VAULT_DB_INSTANCE point-in-time recovery under ${VAULT_PITR_MAX_AGE_S}s old"
  fi
fi

# ── (f) deploy ───────────────────────────────────────────────────────────────────────────────────────
STAGE=deploy
T0=$SECONDS
ROLLBACK="aws ssm start-session --target $INSTANCE --profile $PROFILE --region $REGION   then: sudo RAWPROD_ROLE=$ROLE /usr/local/sbin/rawprod-deploy --rollback"
if ssm_apply deploy 3600 "install $SHORT's own deploy.sh as /usr/local/sbin/rawprod-deploy (sha256 ${DEPLOY_SHA256:0:12}...), then RAWPROD_ROLE=$ROLE rawprod-deploy $FULL" <<< "$(remote_deploy)"; then
  if [ "$APPLY" = 1 ]; then
    printf '%s\n' "$SSM_OUT" | tail -12 | sed 's/^/        /'
    gate deploy ok "$((SECONDS - T0))" "deploy.sh $SHORT, $(kv log)"
  else
    gate deploy would 0 "RAWPROD_ROLE=$ROLE rawprod-deploy $SHORT"
  fi
else
  printf '%s\n' "$SSM_OUT" | tail -25 | sed 's/^/        /' >&2
  gate deploy FAILED "$((SECONDS - T0))" "deploy.sh exit $(kv deploy_exit)"
  VERDICT="DEPLOY FAILED on $INSTANCE: read deploy.sh's last lines above. A failed build left the old process running; a failed health check means the new one is up and unwell"
  die "deploy.sh failed on $INSTANCE. To go back: $ROLLBACK"
fi

# ── publish the consoles (main only: all three static roots live on the main box) ───────────────────
STAGE=static
T0=$SECONDS
if [ "$ROLE" = main ]; then
  if ssm_apply static 300 "infra/aws/nginx/install-static.sh prod (factory, platform and vault console roots), only if DEPLOYED_SHA is $SHORT" <<< "$(remote_static)"; then
    if [ "$APPLY" = 1 ]; then gate "publish consoles" ok "$((SECONDS - T0))" "$(printf '%s\n' "$SSM_OUT" | grep -c '^published ') roots published"
    else gate "publish consoles" would 0 "install-static.sh prod"; fi
  else
    gate "publish consoles" FAILED "$((SECONDS - T0))" "$(printf '%s' "$SSM_OUT" | tail -1)"
    VERDICT="DEPLOYED BUT NOT GREEN: the API runs $SHORT and the consoles were not published"
    die "install-static.sh failed after the API was deployed: $(printf '%s' "$SSM_OUT" | tail -2). To go back: $ROLLBACK"
  fi
else
  gate "publish consoles" skipped 0 "the vault console's static root is on the main box; a --role main ship publishes it"
fi

# ── (g) health, from outside ─────────────────────────────────────────────────────────────────────────
STAGE=health
T0=$SECONDS
if [ "$APPLY" = 1 ]; then
  RED=""
  ssm_read status 60 <<< "$(remote_status)" || RED="$RED; the box could not be read"
  NOW_DEPLOYED=$(kv deployed)
  [ "$NOW_DEPLOYED" = "$FULL" ] || RED="$RED; DEPLOYED_SHA on the box is ${NOW_DEPLOYED:-unread}, not $SHORT"
  for host in "$FACTORY_HOST" "$PLATFORM_HOST" "$VAULT_HOST"; do
    code=000
    for _ in 1 2 3 4 5; do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$host/health" || echo 000)
      [ "$code" = 200 ] && break
      sleep "${SHIP_HEALTH_RETRY_S:-6}"
    done
    echo "    https://$host/health : $code"
    [ "$code" = 200 ] || RED="$RED; https://$host/health answered $code"
  done
  if [ -n "$RED" ]; then
    gate health FAILED "$((SECONDS - T0))" "${RED#; }"
    VERDICT="DEPLOYED BUT NOT GREEN: ${RED#; }"
    die "DEPLOYED BUT NOT GREEN: ${RED#; }. To go back: $ROLLBACK"
  fi
  gate health ok "$((SECONDS - T0))" "DEPLOYED_SHA is $SHORT; /health 200 on $FACTORY_HOST, $PLATFORM_HOST, $VAULT_HOST"
  VERDICT="DEPLOYED GREEN: $SHORT on $INSTANCE ($ROLE)"
else
  echo "    WOULD CHECK: /srv/rawprod/DEPLOYED_SHA on $INSTANCE equals $FULL"
  echo "    WOULD CHECK: https://$FACTORY_HOST/health, https://$PLATFORM_HOST/health, https://$VAULT_HOST/health answer 200"
  echo "    WOULD RUN on $INSTANCE: release the ship lock, append one line to /etc/rawprod/ship-log.jsonl"
  gate health would 0 "DEPLOYED_SHA and /health on three hosts"
  VERDICT="DRY RUN PASSED: $SHORT is proven locally; nothing was sent to change $INSTANCE. Deploy with: infra/aws/ship.sh $SHORT --role $ROLE --apply"
fi
STAGE=done
