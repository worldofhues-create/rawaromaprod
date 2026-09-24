#!/usr/bin/env bash
# DEMO-INFRA: one-shot reset of the ALEMBIC OS DEMO environment. Destroys ONLY demo data.
#
#   From an operator shell (runs both halves over SSM, vault box first):
#     AWS_PROFILE=rawaroma AWS_USE_DUALSTACK_ENDPOINT=true infra/aws/demo/reset-demo.sh ssm [FORMULA_TARGET=vault|local]
#   On a box as root:   reset-demo.sh vault      then      reset-demo.sh app
#
# vault box: drop+recreate vault_demo (own roles), migrate formula (vault-demo-migrate.service: migrate + grants).
# app box:   drop+recreate alembic_demo and rawprod_demo (own roles) -> alembic-demo-migrate (migrate + alembic_app->demo grant move)
#            -> `pnpm demo:seed` (ALEMBIC) -> write /etc/alembic-demo/tenant-id, re-render env -> create the `demo` account
#            (password from SSM /rawaroma/demo/password, on stdin only; demo access stays OFF until Admin -> Settings ->
#            Security & access -> demo.access_enabled) -> rawprod-demo-migrate -> `pnpm demo:seed` (RawProd, RAWPROD_ENVIRONMENT=demo)
#            -> restart whichever demo units were enabled.
# Requires the demo artifacts deployed at /srv/alembic-demo/app and /srv/rawprod-demo/app (P0). Refuses otherwise.
#
# FORMULA_TARGET (RawProd seed writes formulas to FORMULA_DATABASE_URL):
#   vault (default) = vault_demo on vault-pg. The app box has NO network path to vault-pg today (vault-db SG admits only the
#                     vault-app SG), so this refuses with an explanation until P0 decides the path (see PROVISIONED.md).
#   local           = formula schema migrated into rawprod_demo itself (demo-only data, weaker isolation than prod). Explicit opt-in.
set -euo pipefail
MODE="${1:?ssm|app|vault}"; shift || true
for kv in "$@"; do export "$kv"; done
FORMULA_TARGET="${FORMULA_TARGET:-vault}"
LIB=/usr/local/lib/rawaroma/demo
log(){ echo "[reset-demo $(date -u +%H:%M:%S)] $*"; }

if [ "$MODE" = ssm ]; then
  D=$(cd "$(dirname "$0")" && pwd); tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  export AWS_REGION="${AWS_REGION:-us-west-2}"
  run(){ # instance cmd
    local blob; blob=$(COPYFILE_DISABLE=1 tar -C "$D" -czf - . 2>/dev/null | base64 | tr -d '\n')
    python3 - "$1" "$blob" "$2" > "$tmp/c.json" <<'PY'
import json,sys
inst,blob,cmd=sys.argv[1:4]
lines=["set -e","install -d -m 755 /usr/local/lib/rawaroma/demo","cd /usr/local/lib/rawaroma/demo",
       f"echo '{blob}' | base64 -d | tar -xzf - --no-same-owner 2>/dev/null","chown -R root:root .",cmd]
print(json.dumps({"InstanceIds":[inst],"DocumentName":"AWS-RunShellScript","Parameters":{"commands":lines,"executionTimeout":["3600"]}}))
PY
    local id st; id=$(aws ssm send-command --cli-input-json "file://$tmp/c.json" --query Command.CommandId --output text)
    while :; do st=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$1" --query Status --output text 2>/dev/null || echo Pending)
      case "$st" in Pending|InProgress|Delayed) sleep 5;; *) break;; esac; done
    aws ssm get-command-invocation --command-id "$id" --instance-id "$1" --query StandardOutputContent --output text
    aws ssm get-command-invocation --command-id "$id" --instance-id "$1" --query StandardErrorContent --output text | tail -20 >&2
    [ "$st" = Success ] || { echo "reset-demo: $1 finished $st" >&2; exit 1; }
  }
  run i-0edad222a96eeed07 "bash reset-demo.sh vault"
  run i-04e7dc4e5edcc1ff7 "bash reset-demo.sh app FORMULA_TARGET=$FORMULA_TARGET"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
envf(){ set -a; . "$1"; set +a; }   # load an env file into THIS shell only (values never echoed)

if [ "$MODE" = vault ]; then
  [ -f /srv/rawprod-demo/app/package.json ] || { echo "refused: /srv/rawprod-demo/app is not deployed" >&2; exit 1; }
  systemctl stop vault-demo-api.service 2>/dev/null || true
  log "recreate vault_demo"; RECREATE=1 "$LIB/provision-db.sh" vault
  log "migrate vault_demo"; systemctl restart vault-demo-migrate.service
  systemctl is-enabled -q vault-demo-api.service 2>/dev/null && systemctl start vault-demo-api.service || true
  log "vault done"; exit 0
fi

[ "$MODE" = app ] || { echo "mode must be ssm|app|vault" >&2; exit 1; }
for d in /srv/alembic-demo/app /srv/rawprod-demo/app; do
  [ -f "$d/package.json" ] || { echo "refused: $d is not deployed (P0 deploys the RC artifact first)" >&2; exit 1; }
done
VPG=vault-pg.creos6e6ye38.us-west-2.rds.amazonaws.com
if [ "$FORMULA_TARGET" = vault ] && ! timeout 5 bash -c "</dev/tcp/$VPG/5432" 2>/dev/null; then
  cat >&2 <<M
refused: FORMULA_TARGET=vault but this box cannot reach $VPG:5432 (vault-db SG admits only the vault-app SG).
Either P0 adds a path for the demo seed, or re-run with FORMULA_TARGET=local (formula tables inside rawprod_demo).
Nothing has been dropped.
M
  exit 2
fi

UNITS="alembic-demo-web.service alembic-demo-api.service alembic-demo-api.socket rawprod-demo-api.service"
ENABLED=""; for u in $UNITS; do systemctl is-enabled -q "$u" 2>/dev/null && ENABLED="$ENABLED $u"; done
log "stopping demo units"; systemctl stop $UNITS 2>/dev/null || true

log "recreate alembic_demo + rawprod_demo"; RECREATE=1 "$LIB/provision-db.sh" app
"$LIB/render-demo-env.sh" app >/dev/null

log "ALEMBIC migrate"; systemctl restart alembic-demo-migrate.service

log "ALEMBIC demo:seed"
( envf /etc/alembic-demo/migrate.env; envf /etc/alembic-demo/api.env; export ALEMBIC_ENVIRONMENT=demo
  cd /srv/alembic-demo/app; runuser -u alembic-demo -- /usr/bin/pnpm demo:seed )

log "tenant id"
TID=$( envf /etc/alembic-demo/migrate.env
  psql "$DATABASE_URL" -X -At -c "SELECT id FROM tenant WHERE slug = 'demo'" )
[[ "$TID" =~ ^[0-9a-f-]{36}$ ]] || { echo "no demo tenant after seed" >&2; exit 1; }
install -m 644 /dev/null /etc/alembic-demo/tenant-id; printf '%s\n' "$TID" > /etc/alembic-demo/tenant-id
"$LIB/render-demo-env.sh" app >/dev/null

log "demo account"
( envf /etc/alembic-demo/migrate.env; export ALEMBIC_ENVIRONMENT=demo ALEMBIC_TENANT_ID="$TID"
  cd /srv/alembic-demo/app
  aws ssm get-parameter --region us-west-2 --name /rawaroma/demo/password --with-decryption --query Parameter.Value --output text \
    | runuser -u alembic-demo -- /usr/bin/node ops/scripts/create-demo-account.mjs --user demo --mark-tenant-demo )

log "RawProd migrate"
if [ "$FORMULA_TARGET" = local ]; then
  # formula schema inside rawprod_demo: override SKIP_TARGETS for this run only
  install -d -m 700 /run/systemd/system/rawprod-demo-migrate.service.d
  printf '[Service]\nEnvironment=SKIP_TARGETS=\n' > /run/systemd/system/rawprod-demo-migrate.service.d/formula-local.conf
  systemctl daemon-reload
fi
systemctl restart rawprod-demo-migrate.service
rm -rf /run/systemd/system/rawprod-demo-migrate.service.d; systemctl daemon-reload

log "RawProd demo:seed (FORMULA_TARGET=$FORMULA_TARGET)"
( envf /etc/rawprod-demo/migrate.env
  if [ "$FORMULA_TARGET" = vault ]; then
    FORMULA_DATABASE_URL="postgres://vault_demo_owner:$(aws ssm get-parameter --region us-west-2 --name /rawaroma/demo/vault/DB_PASSWORD_owner --with-decryption --query Parameter.Value --output text | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip(),safe=""))')@$VPG:5432/vault_demo?sslmode=require"
  else FORMULA_DATABASE_URL="$DATABASE_URL"; fi
  export FORMULA_DATABASE_URL RAWPROD_ENVIRONMENT=demo PATH=/opt/node-v22.12.0/bin:$PATH
  unset NODE_ENV APP_ENV SKIP_TARGETS
  cd /srv/rawprod-demo/app; runuser -u rawprod-demo -- env PATH="$PATH" pnpm demo:seed )

# re-apply grants: the seed may create objects (e.g. sequences) after the migrate-time grant pass
( envf /etc/rawprod-demo/migrate.env; psql "$DATABASE_URL" -X -q -v app=rawprod_demo_app -v skip= -f "$LIB/sql/app-role-grants.sql" )

for u in $ENABLED; do systemctl start "$u"; done
log "app done (tenant ${TID:0:8}..., demo account 'demo' created with demo access OFF; enabled units restarted:${ENABLED:- none})"
