#!/usr/bin/env bash
# Renders the RawProd env files from SSM Parameter Store (mode 600, root-owned; systemd reads them as root).
# usage: render-env.sh app|vault     Re-run after any SSM change; values are never printed.
#
# OPS_GREEN §17 (env drift): this now renders every key the live boxes run with (read 2026-09-25,
# key NAMES and non-secret values only, via read-only SSM). A re-render used to DROP
# ALEMBIC_ASSERTION_TENANT_ID, INTERNAL_BRIDGE_KEY, VAULT_API_INTERNAL_URL, RUN_WORKER_IN_PROCESS,
# FORMULA_DATABASE_URL/FORMULA_KMS_KEY_ID, BRIDGE_HMAC_KEK and GIT_SHA from the app box, narrow
# RAWPROD_ASSERTION_EXPECTED_TARGETS back to factory,platform, and give the vault box a
# DATABASE_URL it must not hold and the wrong CORS origin.
#
# Three sources, in order of preference, and NOTHING is ever echoed:
#   g <param>                   SSM, required (set -e fails the render if it is absent)
#   carry <param> <KEY> <file>  SSM if this box's role can read the parameter, else the value already
#                               in <file> (a value whose parameter this box is deliberately NOT
#                               granted, e.g. the app box and /rawaroma/vault/*); the render refuses
#                               rather than write the key empty
#   constants                   non-secret facts: the vault box's private address, the hostnames
#
# Live capture (lane cfg-rp, read-only SSM 2026-09-25): every secret this renders was checked equal to its SSM
# parameter ON the box (compared there, never printed). The one value a re-render would still have changed was the
# app box's FORMULA_KMS_KEY_ID: the box runs with alias/rawprod-vault-envelope, and `carry` read the key ARN from
# /rawaroma/vault/FORMULA_KMS_KEY_ID instead (the app role CAN read it). Same KMS key (the alias targets
# 83c66cf8-...), but a different string -- so it is now the alias, as live.
# RENDER_ROOT (test-only) prefixes every path this script reads or writes, so
# backend/api/src/__tests__/infra-live-capture.test.ts can run it for real against a sandbox. Empty on a box.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
g(){ aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
has_param(){ aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1; }
E="${RENDER_ROOT:-}"
current(){ [ -f "$E$2" ] && grep -E "^$1=" "$E$2" | head -1 | cut -d= -f2- || true; }
carry(){ # param KEY file
  if has_param "$1"; then g "$1"; return; fi
  local v; v=$(current "$2" "$3")
  [ -n "$v" ] || { echo "render-env: $2 has no SSM parameter ($1) and no current value in $3; refusing to render it empty" >&2; exit 1; }
  printf '%s' "$v"
}
# KEY=value when the key has a value already on the box, else no line (carried, never regenerated).
keep(){ local v; v=$(current "$1" "$2"); [ -z "$v" ] || printf '%s=%s\n' "$1" "$v"; }
# The checked-out commit IS what runs (deploy.sh checks out an exact SHA); fall back to the current value.
git_sha(){ git -c safe.directory="$E$1" -C "$E$1" rev-parse HEAD 2>/dev/null || current GIT_SHA "$2"; }
umask 077; install -d -m 755 "$E/etc/rawprod"
put(){ local f=$E$1; local t; t=$(mktemp "$E/etc/rawprod/.envXXXX"); cat > "$t"; chmod 600 "$t"; [ "$(id -u)" != 0 ] || chown root:root "$t"; mv -f "$t" "$f"; echo "rendered $1 ($(wc -l < "$f") lines)"; }
VAULT_PRIVATE=172.31.51.157      # the vault box; also infra/aws/nginx/rawvault.conf's upstream
VAULT_PG=vault-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432
COMMON="NODE_ENV=production
APP_ENV=prod
PORT=4100
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
ALEMBIC_ASSERTION_ISSUER=alembic
ALEMBIC_ASSERTION_AUDIENCE=rawprod"
case "${1:?app|vault}" in
app)
  # Read before rendering: `carry` falls back to the file this render is about to replace.
  # Read into variables first: a failed $(g ...) INSIDE a heredoc would render an empty value
  # instead of stopping the render; an assignment fails the script under set -e.
  # INTERNAL_BRIDGE_KEY: one SSM parameter both boxes' roles are granted (vault-ops / rawprod-runtime).
  IBK=$(g /rawaroma/bridge/internal-bridge-key)
  SHA=$(git_sha /srv/rawprod/app /etc/rawprod/api.env)
  TENANT=$(g /rawaroma/rawprod/ALEMBIC_ASSERTION_TENANT_ID)
  # The KMS key id is not a secret: the alias the app box runs with (the vault box renders the key ARN from SSM).
  KMS=alias/rawprod-vault-envelope
  KEK=$(g /rawaroma/rawprod/bridge-hmac-kek)
  DBURL=$(g /rawaroma/rawprod/DATABASE_URL)
  JWT=$(g /rawaroma/rawprod/JWT_SECRET)
  VERIFY=$(g /rawaroma/rawprod/assertion-verify-key)
  MIGURL=$(g /rawaroma/rawprod/MIGRATE_DATABASE_URL)
  put /etc/rawprod/api.env <<X
$COMMON
DATABASE_URL=$DBURL
JWT_SECRET=$JWT
ALEMBIC_ASSERTION_VERIFY_KEY=$VERIFY
ALEMBIC_ASSERTION_TENANT_ID=$TENANT
RAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform,vault
CORS_ORIGINS=https://rawfactory.huecycle.in,https://rawplatform.huecycle.in
# The worker (outbox publisher, bridge relay, schedulers) runs in this process: there is no separate worker unit.
RUN_WORKER_IN_PROCESS=true
# Vault calls go over the private network to vault-api, signed with the key both boxes share.
VAULT_API_INTERNAL_URL=http://$VAULT_PRIVATE:4100
INTERNAL_BRIDGE_KEY=$IBK
# The app box never holds the vault DB password: the URL is present (config shape), unusable alone.
FORMULA_DATABASE_URL=postgres://ra_vault@$VAULT_PG/vault?sslmode=require
FORMULA_KMS_KEY_ID=$KMS
FORMULA_KMS_REGION=us-west-2
# Seals/opens the bridge connector's HMAC secret at rest (backend/api/src/bridge/secret-box.ts).
BRIDGE_HMAC_KEK=$KEK
GIT_SHA=$SHA
X
  put /etc/rawprod/migrate.env <<X
NODE_ENV=production
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
DATABASE_URL=$MIGURL
SKIP_TARGETS=formula
X
  ;;
vault)
  IBK=$(g /rawaroma/bridge/internal-bridge-key)
  SHA=$(git_sha /srv/rawprod/app /etc/rawprod/vault.env)
  # The vault role is granted three /rawaroma/rawprod/* parameters, not this one: carried.
  TENANT=$(carry /rawaroma/rawprod/ALEMBIC_ASSERTION_TENANT_ID ALEMBIC_ASSERTION_TENANT_ID /etc/rawprod/vault.env)
  # The KMS-wrapped audit-chain HMAC key, if the vault has been given one: dropping it would make
  # vault-api mint a new chain key on its next boot (aws-kms.adapter.ts) and orphan every earlier row.
  AUDIT=$(keep FORMULA_AUDIT_HMAC_WRAPPED /etc/rawprod/vault.env)
  # Read before the heredoc (a failed $(g ...) inside one renders an empty value instead of stopping).
  FDBURL=$(g /rawaroma/vault/FORMULA_DATABASE_URL)
  VKMS=$(g /rawaroma/vault/FORMULA_KMS_KEY_ID)
  JWT=$(g /rawaroma/rawprod/JWT_SECRET)
  VERIFY=$(g /rawaroma/rawprod/assertion-verify-key)
  MIGFURL=$(g /rawaroma/vault/MIGRATE_FORMULA_DATABASE_URL)
  # VAULT_MODE, and NO DATABASE_URL: vault-main boots the vault-only module set and must not be able
  # to reach the main RawProd database at all (backend/api/src/vault-main.ts).
  put /etc/rawprod/vault.env <<X
$COMMON
VAULT_MODE=true
FORMULA_DATABASE_URL=$FDBURL
FORMULA_KMS_KEY_ID=$VKMS
FORMULA_KMS_REGION=us-west-2
# P0 decision (2026-09-24, lane FIXV): vault-api verifies RawProd-issued JWTs (VONLY design,
# see vault-api.service's own header) — it MUST use the SAME signing key as rawprod-api's
# api.env, so this reads the rawprod JWT_SECRET param directly rather than a separate
# /rawaroma/vault/JWT_SECRET copy that could silently drift out of sync (that param is retired).
JWT_SECRET=$JWT
ALEMBIC_ASSERTION_VERIFY_KEY=$VERIFY
ALEMBIC_ASSERTION_TENANT_ID=$TENANT
RAWPROD_ASSERTION_EXPECTED_TARGETS=vault
# The public Formula Vault console (infra/aws/nginx/rawvault.conf).
CORS_ORIGINS=https://rawvault.huecycle.in
INTERNAL_BRIDGE_KEY=$IBK
GIT_SHA=$SHA
$AUDIT
X
  put /etc/rawprod/vault-migrate.env <<X
NODE_ENV=production
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
FORMULA_DATABASE_URL=$MIGFURL
SKIP_TARGETS=main
X
  ;;
esac
