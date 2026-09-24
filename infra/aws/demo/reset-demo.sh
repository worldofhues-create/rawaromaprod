#!/usr/bin/env bash
# DEMO-INFRA: one-shot reset of the ALEMBIC OS DEMO environment. Destroys ONLY demo data.
#
#   From an operator shell (runs both halves over SSM):
#     AWS_PROFILE=rawaroma AWS_USE_DUALSTACK_ENDPOINT=true infra/aws/demo/reset-demo.sh ssm
#   On a box as root:   reset-demo.sh vault      then      reset-demo.sh app
#
# vault box: drop+recreate vault_demo (own roles), migrate formula (vault-demo-migrate.service:
#            migrate + grants) -> `pnpm demo:seed:vault` (the demo formula-seed VAULT PHASE:
#            seals the 2 demo formulas straight into vault_demo through the real vault-main
#            services, encrypted with AwsKmsAdapter whenever FORMULA_KMS_KEY_ID is set — see
#            scripts/demo-seed-vault.ts / resolveSeedKmsAdapter).
# app box:   drop+recreate alembic_demo and rawprod_demo (own roles) -> alembic-demo-migrate
#            (migrate + alembic_app->demo grant move) -> `pnpm demo:seed` (ALEMBIC) -> write
#            /etc/alembic-demo/tenant-id, re-render env -> create the `demo` account (password
#            from SSM /rawaroma/demo/password, on stdin only; demo access stays OFF until Admin
#            -> Settings -> Security & access -> demo.access_enabled) -> rawprod-demo-migrate ->
#            `pnpm demo:seed:factory` (the demo formula-seed FACTORY PHASE: everything in
#            rawprod_demo EXCEPT the formula vault itself — see scripts/demo-seed-factory.ts)
#            -> restart whichever demo units were enabled.
# Requires the demo artifacts deployed at /srv/alembic-demo/app and /srv/rawprod-demo/app (P0).
# Refuses otherwise.
#
# P0 decision (2026-09-24, lane FIXV): the RawProd demo formula seed is split into these two
# INDEPENDENT phases specifically so formula seeding runs ON THE VAULT BOX — there is no new
# network path from the app box to vault-pg (the old FORMULA_TARGET=vault/local choice this
# script used to make is gone; the factory phase never touches FORMULA_DATABASE_URL at all now).
# Neither phase depends on the other having already run (scripts/demo-seed-shared.ts's
# deterministic id contract — both phases derive the same material/formula ids from the same
# business-key codes, independently), so running vault before app below is a convenience that
# mirrors this script's own DB-recreate ordering, not a correctness requirement.
set -euo pipefail
MODE="${1:?ssm|app|vault}"; shift || true
for kv in "$@"; do export "$kv"; done
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
  run i-04e7dc4e5edcc1ff7 "bash reset-demo.sh app"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
envf(){ set -a; . "$1"; set +a; }   # load an env file into THIS shell only (values never echoed)

if [ "$MODE" = vault ]; then
  [ -f /srv/rawprod-demo/app/package.json ] || { echo "refused: /srv/rawprod-demo/app is not deployed" >&2; exit 1; }
  systemctl stop vault-demo-api.service 2>/dev/null || true
  log "recreate vault_demo"; RECREATE=1 "$LIB/provision-db.sh" vault
  log "migrate vault_demo"; systemctl restart vault-demo-migrate.service
  log "vault demo:seed (formula vault phase)"
  ( envf /etc/rawprod-demo/vault.env
    export PATH=/opt/node-v22.12.0/bin:$PATH
    # vault.env is the real runtime env (NODE_ENV=production APP_ENV=prod) — demo-seed.ts's
    # assertNotProd() refuses to run under either, same reason app mode below unsets them.
    unset NODE_ENV APP_ENV
    cd /srv/rawprod-demo/app; runuser -u rawprod-demo -- env PATH="$PATH" pnpm demo:seed:vault )
  systemctl is-enabled -q vault-demo-api.service 2>/dev/null && systemctl start vault-demo-api.service || true
  log "vault done"; exit 0
fi

[ "$MODE" = app ] || { echo "mode must be ssm|app|vault" >&2; exit 1; }
for d in /srv/alembic-demo/app /srv/rawprod-demo/app; do
  [ -f "$d/package.json" ] || { echo "refused: $d is not deployed (P0 deploys the RC artifact first)" >&2; exit 1; }
done

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
systemctl restart rawprod-demo-migrate.service

log "RawProd demo:seed (factory phase)"
( envf /etc/rawprod-demo/migrate.env
  export RAWPROD_ENVIRONMENT=demo PATH=/opt/node-v22.12.0/bin:$PATH
  unset NODE_ENV APP_ENV SKIP_TARGETS
  cd /srv/rawprod-demo/app; runuser -u rawprod-demo -- env PATH="$PATH" pnpm demo:seed:factory )

# re-apply grants: the seed may create objects (e.g. sequences) after the migrate-time grant pass
( envf /etc/rawprod-demo/migrate.env; psql "$DATABASE_URL" -X -q -v app=rawprod_demo_app -v skip= -f "$LIB/sql/app-role-grants.sql" )

for u in $ENABLED; do systemctl start "$u"; done
log "app done (tenant ${TID:0:8}..., demo account 'demo' created with demo access OFF; enabled units restarted:${ENABLED:- none})"
