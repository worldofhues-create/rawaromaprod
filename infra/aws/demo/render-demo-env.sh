#!/usr/bin/env bash
# DEMO-INFRA: render the demo env files from SSM /rawaroma/demo/* (root 0600; values never printed).
#   app box:   render-demo-env.sh app    -> /etc/alembic-demo/{api,web,migrate}.env, /etc/rawprod-demo/{api,migrate}.env
#   vault box: render-demo-env.sh vault  -> /etc/rawprod-demo/{vault,vault-migrate}.env, /etc/rawprod-demo/aws-config
# The demo ALEMBIC tenant id is written by reset-demo.sh to /etc/alembic-demo/tenant-id (it exists only after the seed).
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
g(){ aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
enc(){ python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
umask 077
put(){ local f=$1; local t; install -d -m 700 "$(dirname "$f")"; t=$(mktemp "$(dirname "$f")/.envXXXX"); cat > "$t"; chmod 600 "$t"; chown root:root "$t"; mv -f "$t" "$f"; echo "rendered $f ($(wc -l < "$f") lines)"; }
APG=alembic-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432
VPG=vault-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432
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
RAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform
CORS_ORIGINS=$FURL
X
  put /etc/rawprod-demo/migrate.env <<X
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
DATABASE_URL=postgres://rawprod_demo_owner:$(enc "$(g /rawaroma/demo/rawprod/DB_PASSWORD_owner)")@$APG/rawprod_demo?sslmode=require
SKIP_TARGETS=formula
X
  ;;
vault)
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
AWS_CONFIG_FILE=/etc/rawprod-demo/aws-config
AWS_SDK_LOAD_CONFIG=1
# P0 decision (2026-09-24, lane FIXV): mirrors prod's render-env.sh — vault-api verifies
# RawProd-issued JWTs, so it MUST use the SAME signing key as rawprod-demo's api.env. Reads the
# demo rawprod JWT_SECRET param directly; /rawaroma/demo/vault/JWT_SECRET is retired.
JWT_SECRET=$(g /rawaroma/demo/rawprod/JWT_SECRET)
ALEMBIC_ASSERTION_ISSUER=alembic
ALEMBIC_ASSERTION_AUDIENCE=rawprod
ALEMBIC_ASSERTION_VERIFY_KEY=$(g /rawaroma/demo/rawprod/assertion-verify-key)
RAWPROD_ASSERTION_EXPECTED_TARGETS=vault
CORS_ORIGINS=$(g /rawaroma/demo/factory-url)
X
  put /etc/rawprod-demo/vault-migrate.env <<X
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
FORMULA_DATABASE_URL=postgres://vault_demo_owner:$(enc "$(g /rawaroma/demo/vault/DB_PASSWORD_owner)")@$VPG/vault_demo?sslmode=require
SKIP_TARGETS=main
X
  # demo vault-api runs as role rawprod-vault-demo (the only principal the demo envelope key allows), assumed from the box role
  install -m 644 /dev/stdin /etc/rawprod-demo/aws-config <<X
[default]
region = us-west-2
role_arn = arn:aws:iam::859485559854:role/rawprod-vault-demo
credential_source = Ec2InstanceMetadata
role_session_name = vault-demo-api
X
  chmod 755 /etc/rawprod-demo; chown root:rawprod-demo /etc/rawprod-demo/aws-config 2>/dev/null || true
  ;;
esac
