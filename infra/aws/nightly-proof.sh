#!/usr/bin/env bash
# SHIP-RP: THE NIGHTLY JOB. What infra/aws/ship.sh no longer waits for, run after the deploy, reported,
# blocking nothing.
#
#   infra/aws/nightly-proof.sh                    # the commit production runs: typecheck and the whole suite
#   infra/aws/nightly-proof.sh --sha <sha>        # a named commit
#   infra/aws/nightly-proof.sh --legs unit,browser
#   infra/aws/nightly-proof.sh --plan             # say what would run, run nothing
#   infra/aws/nightly-proof.sh --force            # run even if this commit already has a green night
#
# WHAT A FAST DEPLOY LEAVES OUT, and the leg that runs it here (Alembic plan, fast-deploy-and-new-host.md
# 1.6 and 1.7; LD-7):
#
#   typecheck   pnpm typecheck                    ship.sh runs it too; here it is on the deployed commit
#   unit        pnpm test, every file, on a throwaway PostgreSQL. ship.sh runs it only when a sensitive
#               path changed; otherwise the always-on list and the touched tests
#   browser     pnpm e2e:up, pnpm e2e, pnpm e2e:down: the Factory, Vault and Platform walks. ship.sh runs
#               no browser at all. NOT a default leg: it starts five servers and a browser, so it runs
#               only when asked (--legs ...,browser), and e2e:down runs on every exit
#
# GitHub runs the same unit and browser sets on its own schedule (.github/workflows/unit-tests.yml and
# browser-suite.yml, `schedule:`), on main. This script is the fallback on the laptop, and the one place
# the verdict lands where ship.sh reads it. The restore drills stay where they are: weekly timers on the
# boxes (infra/aws/restore-drill/).
#
# THREE RULES, each the difference between a report and a second gate:
#
#   IT NEVER BLOCKS. ship.sh PRINTS the last verdict before it deploys and deploys anyway. A red night is
#   a defect already in production: fix it through ship.sh, first thing.
#   IT NEVER WRITES EVIDENCE A DEPLOY READS. Its output is $RAWPROD_NIGHTLY_DIR (~/.rawprod/nightly),
#   never ~/.rawprod/ship-evidence, so a green night is never reused as a deploy's proof.
#   IT MAKES NO AWS CALL, with or without any flag. There is no remote leg. The commit comes from --sha,
#   RAWPROD_DEPLOYED_SHA or this laptop's last green ship; every leg runs with the AWS_* variables, the
#   database URLs and the libpq PG* variables removed, on 127.0.0.1 only.
#
# It cleans up after itself: the throwaway PostgreSQL is stopped by its PID and deleted, the worktree is
# removed, and the logs are kept beside the verdict.
#
# Schedule it on the release laptop, for example (02:00 IST):
#   30 20 * * *  cd <a clean checkout> && PATH=$HOME/.nvm/versions/node/v22.22.2/bin:/opt/homebrew/bin:$PATH infra/aws/nightly-proof.sh >> $HOME/.rawprod/nightly/cron.log 2>&1
[ -n "${BASH_VERSION:-}" ] || { echo "FATAL: infra/aws/nightly-proof.sh is a bash script" >&2; exit 2; }
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/../.." && pwd)
REPO="${SHIP_REPO:-$TOOLS}"
OUT_ROOT="${RAWPROD_NIGHTLY_DIR:-$HOME/.rawprod/nightly}"
EVIDENCE_ROOT="${RAWPROD_SHIP_EVIDENCE:-$HOME/.rawprod/ship-evidence}"
PG_BIN="${SHIP_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"   # PostGIS is installed for 17 only
PG_PORT="${NIGHTLY_PG_PORT:-5418}"                             # not ship.sh's 5417: the two may overlap
MIN_FREE_GB="${SHIP_MIN_FREE_GB:-10}"

SHA_ARG=""; LEGS="typecheck,unit"; PLAN=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA_ARG="${2:-}"; shift ;;
    --legs) LEGS="${2:-}"; shift ;;
    --plan) PLAN=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "FATAL: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
for l in $(printf '%s' "$LEGS" | tr ',' ' '); do
  case "$l" in typecheck|unit|browser) ;; *) echo "FATAL: --legs takes typecheck, unit, browser; not '$l'" >&2; exit 2 ;; esac
done
has() { case ",$LEGS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

env_names() { env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | grep -E "$1" | sort -u | tr '\n' ' ' || true; }
for v in $(env_names '(DATABASE_URL|^PG(HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|SSLMODE|SSLROOTCERT|OPTIONS)$|^AWS_)'); do unset "$v"; done
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true

die() { echo "FATAL: $*" >&2; exit 2; }

# ── which commit ─────────────────────────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "no node on PATH. export PATH=\$HOME/.nvm/versions/node/v22.22.2/bin:\$PATH"
[ "$(node -p 'process.versions.node.split(".")[0]')" = 22 ] || die "node is $(node -v), and production runs 22"
if [ -n "$SHA_ARG" ]; then FROM="--sha"
elif [ -n "${RAWPROD_DEPLOYED_SHA:-}" ]; then SHA_ARG="$RAWPROD_DEPLOYED_SHA"; FROM="RAWPROD_DEPLOYED_SHA"
else
  SHA_ARG=$(node "$TOOLS/infra/aws/ship-evidence.mjs" last-deployed --root "$EVIDENCE_ROOT" --role main 2>/dev/null || true)
  FROM="this laptop's last green ship (main)"
  [ -n "$SHA_ARG" ] || die "no commit named and no green ship recorded on this laptop. Name it: infra/aws/nightly-proof.sh --sha <the deployed sha>. This script asks AWS nothing"
fi
git -C "$REPO" fetch --quiet origin 2>/dev/null || echo "    git fetch origin failed; using what this clone has" >&2
FULL=$(git -C "$REPO" rev-parse --verify --quiet "${SHA_ARG}^{commit}") || die "commit $SHA_ARG is not in $REPO"
SHORT=${FULL:0:8}

echo "==> nightly RawProd: $SHORT (from $FROM), legs $LEGS"
if [ "$PLAN" = 1 ]; then
  has typecheck && echo "    WOULD RUN: pnpm typecheck, in a fresh worktree at $SHORT"
  has unit && echo "    WOULD RUN: pnpm test, every file, on a throwaway PostgreSQL at 127.0.0.1:$PG_PORT"
  has browser && echo "    WOULD RUN: pnpm e2e:up, pnpm e2e, pnpm e2e:down"
  has browser || echo "    NOT RUN: the browser walks (--legs typecheck,unit,browser to include them)"
  echo "    WOULD WRITE: $OUT_ROOT/<stamp>-$SHORT/nightly.json and $OUT_ROOT/latest.json"
  echo "VERDICT: PLAN: nothing was run"
  exit 0
fi
if [ "$FORCE" = 0 ] && [ -f "$OUT_ROOT/latest.json" ]; then
  if node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(j.sha===process.argv[2] && j.verdict==="GREEN" && j.legs_asked===process.argv[3] ? 0 : 1)' \
      "$OUT_ROOT/latest.json" "$FULL" "$LEGS" 2>/dev/null; then
    echo "VERDICT: NOTHING NEW: $SHORT already has a green night with these legs. --force runs it again"
    exit 0
  fi
fi

FREE_GB=$(df -Pk / | awk 'NR==2 {print int($4/1048576)}')
[ "$FREE_GB" -ge "$MIN_FREE_GB" ] || die "only ${FREE_GB} GB free on /: ${MIN_FREE_GB} GB needed. Clean up first"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$OUT_ROOT/$STAMP-$SHORT"
mkdir -p "$OUT/logs"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/rawprod-nightly.XXXXXX")
WT="$WORK/wt"; PGDATA="$WORK/pg"; PG_PID=""; E2E_UP=0; LAST=""
: > "$WORK/legs.tsv"

finish() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  if [ "$E2E_UP" = 1 ]; then ( cd "$WT" && pnpm e2e:down ) >> "$OUT/logs/browser.log" 2>&1; fi
  if [ -n "$PG_PID" ]; then "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate -w -t 30 stop >/dev/null 2>&1 || kill "$PG_PID" 2>/dev/null; fi
  [ -d "$WT" ] && git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1
  git -C "$REPO" worktree prune >/dev/null 2>&1
  rm -rf "$WORK"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT TERM

leg() { # name, command... -> a row in legs.tsv; a red leg does not stop the others
  local name="$1" t0=$SECONDS rc=0; shift
  set +e; ( set -e; "$@" ) > "$OUT/logs/$name.log" 2>&1; rc=$?; set -e
  local st=ok; [ "$rc" = 0 ] || st=FAILED
  LAST=$st
  printf '%s\t%s\t%s\t%s\n' "$name" "$st" "$((SECONDS - t0))" "logs/$name.log" >> "$WORK/legs.tsv"
  printf '  %-8s %-10s %5ss\n' "$st" "$name" "$((SECONDS - t0))"
}

git -C "$REPO" worktree add --quiet --detach "$WT" "$FULL" > "$OUT/logs/worktree.log" 2>&1 || die "could not create a worktree at $SHORT"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
leg install pnpm -C "$WT" install --frozen-lockfile --prefer-offline
has typecheck && leg typecheck pnpm -C "$WT" typecheck
start_pg() { # the throwaway cluster; a listener this run did not start is somebody else's, never adopted
  if (exec 3<>"/dev/tcp/127.0.0.1/$PG_PORT") 2>/dev/null; then echo "port $PG_PORT is already listening and this run did not start it (NIGHTLY_PG_PORT)"; return 1; fi
  local -a pgenv
  pgenv=(env LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8)
  "${pgenv[@]}" "$PG_BIN/initdb" -D "$PGDATA" -U ship --auth=trust -E UTF8 --locale=en_US.UTF-8
  "${pgenv[@]}" "$PG_BIN/pg_ctl" -D "$PGDATA" -w -t 60 -l "$OUT/logs/postgres.log" \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c max_connections=60" start
  "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U ship -d postgres -XAtq -v ON_ERROR_STOP=1 -c "create database ship_nightly"
}
if has unit; then
  leg postgres start_pg
  # The postmaster's PID, read from its own file: the trap stops exactly that process and no other.
  [ ! -f "$PGDATA/postmaster.pid" ] || PG_PID=$(head -1 "$PGDATA/postmaster.pid")
  if [ "$LAST" = ok ]; then leg unit env "TEST_DATABASE_URL=postgres://ship@127.0.0.1:$PG_PORT/ship_nightly" pnpm -C "$WT" test
  else printf '%s\t%s\t%s\t%s\n' unit FAILED 0 "not run: the throwaway PostgreSQL did not start, see logs/postgres.log" >> "$WORK/legs.tsv"; fi
fi
if has browser; then
  E2E_UP=1
  leg browser bash -c 'cd "$1" && pnpm e2e:up && pnpm e2e' _ "$WT"
fi

# ── the verdict, where ship.sh reads it ──────────────────────────────────────────────────────────────
node -e '
  const fs = require("fs");
  const [legsFile, out, latest, sha, started, legsAsked] = process.argv.slice(1);
  const legs = fs.readFileSync(legsFile, "utf8").split("\n").filter(Boolean).map((l) => {
    const [name, status, seconds, log] = l.split("\t"); return { name, status, seconds: Number(seconds), log };
  });
  const asked = legsAsked.split(",");
  const notRun = ["typecheck", "unit", "browser"].filter((l) => !asked.includes(l));
  const doc = { tool: "infra/aws/nightly-proof.sh", sha, started, legs_asked: legsAsked, finished: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    verdict: legs.every((l) => l.status === "ok") ? "GREEN" : "RED", legs,
    not_run: notRun.map((l) => `${l}: not asked for (--legs)`),
    note: "a report: no deploy reads this file, and a green night is never a deploy proof" };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  fs.writeFileSync(latest, JSON.stringify(doc, null, 2) + "\n");
  console.log(`VERDICT: ${doc.verdict}`);
  process.exit(doc.verdict === "GREEN" ? 0 : 1);
' "$WORK/legs.tsv" "$OUT/nightly.json" "$OUT_ROOT/latest.json" "$FULL" "$STAMP" "$LEGS"
