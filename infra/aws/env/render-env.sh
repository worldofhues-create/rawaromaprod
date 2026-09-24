#!/usr/bin/env bash
# Renders the RawProd env files from SSM Parameter Store (mode 600, root-owned; systemd reads them as root).
# usage: render-env.sh app|vault     Re-run after any SSM change; values are never printed.
# Hostnames/CORS are PLACEHOLDERS until H7 DNS lands (see PROVISIONED.md); edit the HOSTS vars below then.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
g(){ aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
umask 077; install -d -m 755 /etc/rawprod
put(){ local f=$1; local t; t=$(mktemp /etc/rawprod/.envXXXX); cat > "$t"; chmod 600 "$t"; chown root:root "$t"; mv -f "$t" "$f"; echo "rendered $f ($(wc -l < "$f") lines)"; }
COMMON="NODE_ENV=production
APP_ENV=prod
PORT=4100
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
ALEMBIC_ASSERTION_ISSUER=alembic
ALEMBIC_ASSERTION_AUDIENCE=rawprod"
case "${1:?app|vault}" in
app)
  put /etc/rawprod/api.env <<X
$COMMON
DATABASE_URL=$(g /rawaroma/rawprod/DATABASE_URL)
JWT_SECRET=$(g /rawaroma/rawprod/JWT_SECRET)
ALEMBIC_ASSERTION_VERIFY_KEY=$(g /rawaroma/rawprod/assertion-verify-key)
RAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform
CORS_ORIGINS=https://rawfactory.huecycle.in,https://rawplatform.huecycle.in
X
  put /etc/rawprod/migrate.env <<X
NODE_ENV=production
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
DATABASE_URL=$(g /rawaroma/rawprod/MIGRATE_DATABASE_URL)
SKIP_TARGETS=formula
X
  ;;
vault)
  put /etc/rawprod/vault.env <<X
$COMMON
DATABASE_URL=$(g /rawaroma/rawprod/DATABASE_URL)
FORMULA_DATABASE_URL=$(g /rawaroma/vault/FORMULA_DATABASE_URL)
FORMULA_KMS_KEY_ID=$(g /rawaroma/vault/FORMULA_KMS_KEY_ID)
FORMULA_KMS_REGION=us-west-2
# P0 decision (2026-09-24, lane FIXV): vault-api verifies RawProd-issued JWTs (VONLY design,
# see vault-api.service's own header) — it MUST use the SAME signing key as rawprod-api's
# api.env, so this reads the rawprod JWT_SECRET param directly rather than a separate
# /rawaroma/vault/JWT_SECRET copy that could silently drift out of sync (that param is retired).
JWT_SECRET=$(g /rawaroma/rawprod/JWT_SECRET)
ALEMBIC_ASSERTION_VERIFY_KEY=$(g /rawaroma/rawprod/assertion-verify-key)
RAWPROD_ASSERTION_EXPECTED_TARGETS=vault
CORS_ORIGINS=https://vault.huecycle.in
X
  put /etc/rawprod/vault-migrate.env <<X
NODE_ENV=production
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
FORMULA_DATABASE_URL=$(g /rawaroma/vault/MIGRATE_FORMULA_DATABASE_URL)
SKIP_TARGETS=main
X
  ;;
esac
