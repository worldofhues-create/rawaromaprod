#!/usr/bin/env bash
# DEMO-INFRA: render the demo env files from SSM /rawaroma/demo/* (root 0600; values never printed).
#   app box:   render-demo-env.sh app    -> /etc/alembic-demo/{api,web,migrate}.env, /etc/rawprod-demo/{api,migrate}.env
#   vault box: render-demo-env.sh vault  -> /etc/rawprod-demo/{vault,vault-migrate}.env
# H1: AWS credentials are NOT rendered here. demo-aws-creds.sh (root, *-demo-aws-creds.timer, every 30 min) writes a
# short-lived demo-role session to /etc/{alembic,rawprod}-demo/aws/ (0640 root:<demo user>); the env only points there.
# No demo env ever carries credential_source=Ec2InstanceMetadata, and every demo unit is IMDS-denied.
# The demo ALEMBIC tenant id is written by reset-demo.sh to /etc/alembic-demo/tenant-id (it exists only after the seed).
#
# OPS_GREEN §17 (env drift): rawprod-demo-api ran with keys this script never rendered — they lived in a
# hand-placed /etc/rawprod-demo/api.extra.env loaded by a drop-in (rawprod-demo-api.service.d/
# 10-vault-env.conf). They are rendered into api.env now, and api.extra.env is retired below, so a
# re-render reproduces the running demo instead of silently dropping the vault/bridge wiring.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
g(){ aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
has_param(){ aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1; }
current(){ [ -f "$2" ] && grep -E "^$1=" "$2" | head -1 | cut -d= -f2- || true; }
# KEY=value from SSM when the parameter exists, else the value already on the box, else no line at all.
opt(){ # KEY param file...
  local k=$1 p=$2 v=""; shift 2
  if has_param "$p"; then v=$(g "$p"); else for f in "$@"; do [ -n "$v" ] || v=$(current "$k" "$f"); done; fi
  [ -z "$v" ] || printf '%s=%s\n' "$k" "$v"
}
git_sha(){ git -c safe.directory="$1" -C "$1" rev-parse HEAD 2>/dev/null || true; }
enc(){ python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
umask 077
put(){ local f=$1; local t; install -d -m 700 "$(dirname "$f")"; t=$(mktemp "$(dirname "$f")/.envXXXX"); cat > "$t"; chmod 600 "$t"; chown root:root "$t"; mv -f "$t" "$f"; echo "rendered $f ($(wc -l < "$f") lines)"; }
APG=alembic-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432
VPG=vault-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432
VAULT_PRIVATE=172.31.51.157      # the vault box (vault-demo-api listens on :4111)
case "${1:?app|vault}" in
app)
  AURL=$(g /rawaroma/demo/alembic-url); FURL=$(g /rawaroma/demo/factory-url)
  TENANT=$(cat /etc/alembic-demo/tenant-id 2>/dev/null || echo UNSET-run-reset-demo)
  put /etc/alembic-demo/api.env <<X
ALEMBIC_ENVIRONMENT=demo
DATABASE_URL_APP=postgres://alembic_demo_app:$(enc "$(g /rawaroma/demo/alembic/DB_PASSWORD_app)")@$APG/alembic_demo?sslmode=verify-full
ALEMBIC_TENANT_ID=$TENANT
NODE_EXTRA_CA_CERTS=/etc/alembic/certs/rds-global-bundle.pem
ALEMBIC_DB_CA_FILE=/etc/alembic/certs/rds-global-bundle.pem
ALEMBIC_PUBLIC_WEB_ORIGIN=$AURL
ALEMBIC_CORS_ORIGINS=$AURL
ALEMBIC_BEDROCK_REGION=us-west-2
AWS_CONFIG_FILE=/etc/alembic-demo/aws/config
AWS_SHARED_CREDENTIALS_FILE=/etc/alembic-demo/aws/credentials
AWS_SDK_LOAD_CONFIG=1
AWS_EC2_METADATA_DISABLED=true
ALEMBIC_SECRET_KEYS=$(g /rawaroma/demo/alembic/SECRET_KEYS)
ALEMBIC_RAWPROD_ASSERTION_SIGNING_KEY=$(g /rawaroma/demo/alembic/rawprod-assertion-signing-key)
ALEMBIC_JANITOR_MS=300000
ALEMBIC_LOOPS_MS=900000
X
  put /etc/alembic-demo/web.env <<X
RAC_API_INTERNAL=http://127.0.0.1:4010
NODE_ENV=production
X
  put /etc/alembic-demo/migrate.env <<X
DATABASE_URL=postgres://alembic_demo_owner:$(enc "$(g /rawaroma/demo/alembic/DB_PASSWORD_owner)")@$APG/alembic_demo?sslmode=verify-full
NODE_EXTRA_CA_CERTS=/etc/alembic/certs/rds-global-bundle.pem
PGSSLROOTCERT=/etc/alembic/certs/rds-global-bundle.pem
X
  # Read into variables first (a failed $(g ...) inside a heredoc renders empty instead of failing).
  RP_EXTRA=/etc/rawprod-demo/api.extra.env
  # The app role is granted /rawaroma/demo/vault/DB_PASSWORD_app only, not the KMS key id (not a secret):
  # read it where granted, else carry the value the demo runs with.
  RP_KMS=$(opt FORMULA_KMS_KEY_ID /rawaroma/demo/vault/FORMULA_KMS_KEY_ID /etc/rawprod-demo/api.env "$RP_EXTRA")
  [ -n "$RP_KMS" ] || { echo "render-demo-env: no FORMULA_KMS_KEY_ID in SSM (readable) or on the box" >&2; exit 1; }
  # The demo seals the bridge secret with its own KEK once /rawaroma/demo/rawprod/bridge-hmac-kek exists; until
  # then with the one it runs with today (the production KEK -- an owner gate, see the lane report).
  if has_param /rawaroma/demo/rawprod/bridge-hmac-kek; then RP_KEK=$(g /rawaroma/demo/rawprod/bridge-hmac-kek)
  else RP_KEK=$(g /rawaroma/rawprod/bridge-hmac-kek); fi
  RP_SHA=$(git_sha /srv/rawprod-demo/app); [ -n "$RP_SHA" ] || RP_SHA=$(current GIT_SHA "$RP_EXTRA")
  # No demo INTERNAL_BRIDGE_KEY exists today (the demo vault has none either); rendered once
  # /rawaroma/demo/rawprod/internal-bridge-key is created and granted -- an owner gate.
  RP_IBK=$(opt INTERNAL_BRIDGE_KEY /rawaroma/demo/rawprod/internal-bridge-key /etc/rawprod-demo/api.env "$RP_EXTRA")
  put /etc/rawprod-demo/api.env <<X
NODE_ENV=production
APP_ENV=prod
RAWPROD_ENVIRONMENT=demo
JWT_ACCESS_TTL=300
PORT=4110
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
DATABASE_URL=postgres://rawprod_demo_app:$(enc "$(g /rawaroma/demo/rawprod/DB_PASSWORD_app)")@$APG/rawprod_demo?sslmode=require
JWT_SECRET=$(g /rawaroma/demo/rawprod/JWT_SECRET)
ALEMBIC_ASSERTION_ISSUER=alembic
ALEMBIC_ASSERTION_AUDIENCE=rawprod
ALEMBIC_ASSERTION_VERIFY_KEY=$(g /rawaroma/demo/rawprod/assertion-verify-key)
ALEMBIC_ASSERTION_TENANT_ID=$TENANT
RAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform
CORS_ORIGINS=$FURL
AWS_EC2_METADATA_DISABLED=true
# The outbox publisher and the bridge relay (RawProd -> ALEMBIC) run in this process; without it the
# demo factory never reports back to the demo ALEMBIC.
RUN_WORKER_IN_PROCESS=true
VAULT_API_INTERNAL_URL=http://$VAULT_PRIVATE:4111
# No vault password on the app box (the prod rule): the URL is present, unusable alone.
FORMULA_DATABASE_URL=postgres://vault_demo_app@$VPG/vault_demo?sslmode=require
$RP_KMS
FORMULA_KMS_REGION=us-west-2
BRIDGE_HMAC_KEK=$RP_KEK
GIT_SHA=$RP_SHA
$RP_IBK
X
  # Everything api.extra.env carried is in api.env now; left in place, its drop-in would load it AFTER
  # api.env and put the vault password back. The drop-in's EnvironmentFile is optional (`-`).
  rm -f "$RP_EXTRA"
  put /etc/rawprod-demo/migrate.env <<X
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
DATABASE_URL=postgres://rawprod_demo_owner:$(enc "$(g /rawaroma/demo/rawprod/DB_PASSWORD_owner)")@$APG/rawprod_demo?sslmode=require
SKIP_TARGETS=formula
X
  ;;
vault)
  # FORMULA_AUDIT_HMAC_WRAPPED is the KMS-wrapped audit-chain HMAC key. It is written on the box, has no
  # SSM home, and a render that dropped it would make vault-api mint a NEW chain key on the next boot
  # (aws-kms.adapter.ts), so every earlier audit row stops verifying. Carried, never regenerated.
  V_AUDIT=$(opt FORMULA_AUDIT_HMAC_WRAPPED /rawaroma/demo/vault/FORMULA_AUDIT_HMAC_WRAPPED /etc/rawprod-demo/vault.env)
  put /etc/rawprod-demo/vault.env <<X
NODE_ENV=production
APP_ENV=prod
RAWPROD_ENVIRONMENT=demo
JWT_ACCESS_TTL=300
PORT=4111
VAULT_MODE=true
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
FORMULA_DATABASE_URL=postgres://vault_demo_app:$(enc "$(g /rawaroma/demo/vault/DB_PASSWORD_app)")@$VPG/vault_demo?sslmode=require
FORMULA_KMS_KEY_ID=$(g /rawaroma/demo/vault/FORMULA_KMS_KEY_ID)
FORMULA_KMS_REGION=us-west-2
AWS_CONFIG_FILE=/etc/rawprod-demo/aws/config
AWS_SHARED_CREDENTIALS_FILE=/etc/rawprod-demo/aws/credentials
AWS_SDK_LOAD_CONFIG=1
AWS_EC2_METADATA_DISABLED=true
# P0 decision (2026-09-24, lane FIXV): mirrors prod's render-env.sh — vault-api verifies
# RawProd-issued JWTs, so it MUST use the SAME signing key as rawprod-demo's api.env. Reads the
# demo rawprod JWT_SECRET param directly; /rawaroma/demo/vault/JWT_SECRET is retired.
JWT_SECRET=$(g /rawaroma/demo/rawprod/JWT_SECRET)
ALEMBIC_ASSERTION_ISSUER=alembic
ALEMBIC_ASSERTION_AUDIENCE=rawprod
ALEMBIC_ASSERTION_VERIFY_KEY=$(g /rawaroma/demo/rawprod/assertion-verify-key)
RAWPROD_ASSERTION_EXPECTED_TARGETS=vault
CORS_ORIGINS=$(g /rawaroma/demo/factory-url)
$V_AUDIT
X
  put /etc/rawprod-demo/vault-migrate.env <<X
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
FORMULA_DATABASE_URL=postgres://vault_demo_owner:$(enc "$(g /rawaroma/demo/vault/DB_PASSWORD_owner)")@$VPG/vault_demo?sslmode=require
SKIP_TARGETS=main
X
  # demo vault-api runs as role rawprod-vault-demo (the only principal the demo envelope key allows). H1: the old
  # /etc/rawprod-demo/aws-config (credential_source=Ec2InstanceMetadata) is retired — the demo process reached IMDS
  # and so could mint the PROD box role. The session now comes from demo-aws-creds.sh vault (root timer).
  rm -f /etc/rawprod-demo/aws-config
  chmod 755 /etc/rawprod-demo
  ;;
esac
