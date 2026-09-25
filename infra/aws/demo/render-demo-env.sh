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
#
# Live capture (lane cfg-rp, read-only SSM 2026-09-25; key NAMES and non-secret values only, every secret checked
# equal to its SSM parameter ON the box without printing it). A re-render now reproduces what the demo runs:
#   /etc/alembic-demo/api.env        ALEMBIC_CORS_ORIGINS = the 4 demo origins + the API Gateway origin,
#                                    ALEMBIC_PUBLIC_ORIGIN, ALEMBIC_BRIDGE_SWEEP_MS, ALEMBIC_{STAFF,ACCOUNT}_MAIL_DROP,
#                                    ALEMBIC_REF_PREFIX=DEMO (set live 2026-09-25; without it the demo API boots with
#                                    the NEFT proforma rail OFF. Production's RAC is the alembic repo's render-env.sh)
#   /etc/alembic-demo/web-build.env  NEXT_PUBLIC_RAWPROD_{FACTORY,PLATFORM,VAULT}_ORIGIN (read by ALEMBIC's
#                                    ops/deploy/deploy-sha.sh at build time; public, mode 644)
#   /etc/rawprod-demo/api.env        RAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform,vault; BRIDGE_HMAC_KEK is the
#                                    KEK the demo RUNS with (see RP_KEK), never switched by a parameter appearing;
#                                    RUN_WORKER_IN_PROCESS=true (always -- the demo outbox and automations need it)
#   /etc/rawprod-demo/vault.env      CORS_ORIGINS also admits https://rawdemovault.huecycle.in (infra/aws/nginx/
#                                    rawdemovault.conf)
# RENDER_ROOT (test-only) prefixes every path this script reads or writes, so
# backend/api/src/__tests__/infra-live-capture.test.ts can run it for real against a sandbox. Empty on a box.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
g(){ aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
has_param(){ aws ssm get-parameter --name "$1" --query Parameter.Name --output text >/dev/null 2>&1; }
E="${RENDER_ROOT:-}"
current(){ [ -f "$E$2" ] && grep -E "^$1=" "$E$2" | head -1 | cut -d= -f2- || true; }
# KEY=value from SSM when the parameter exists, else the value already on the box, else no line at all.
opt(){ # KEY param file...
  local k=$1 p=$2 v=""; shift 2
  if has_param "$p"; then v=$(g "$p"); else for f in "$@"; do [ -n "$v" ] || v=$(current "$k" "$f"); done; fi
  [ -z "$v" ] || printf '%s=%s\n' "$k" "$v"
}
git_sha(){ git -c safe.directory="$E$1" -C "$E$1" rev-parse HEAD 2>/dev/null || true; }
enc(){ python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }
umask 077
# A MISSING directory is created 0700; an existing one keeps its mode (`install -d -m` would chmod it, and
# /etc/alembic-demo is 0711 on the box: demo-aws-creds.sh opens it for traverse so the demo user reaches aws/).
put(){ local f=$E$1; local t; [ -d "$(dirname "$f")" ] || install -d -m 700 "$(dirname "$f")"; t=$(mktemp "$(dirname "$f")/.envXXXX"); cat > "$t"; chmod 600 "$t"; [ "$(id -u)" != 0 ] || chown root:root "$t"; mv -f "$t" "$f"; echo "rendered $1 ($(wc -l < "$f") lines)"; }
# The first line that failed to read stops the render: every value is read into a variable BEFORE its heredoc,
# because a failed $(g ...) inside a heredoc renders an empty value instead of stopping.
req(){ local v; v=$(g "$1"); [ -n "$v" ] || { echo "render-demo-env: $1 is empty; refusing to render it" >&2; exit 1; }; printf '%s' "$v"; }
APG=alembic-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432
VPG=vault-pg.creos6e6ye38.us-west-2.rds.amazonaws.com:5432
VAULT_PRIVATE=172.31.51.157      # the vault box (vault-demo-api listens on :4111)
case "${1:?app|vault}" in
app)
  AURL=$(req /rawaroma/demo/alembic-url); FURL=$(req /rawaroma/demo/factory-url)
  TENANT=$(cat "$E/etc/alembic-demo/tenant-id" 2>/dev/null || echo UNSET-run-reset-demo)
  # The public demo names (infra/aws/nginx/huecycle-hosts.conf). The consoles call the API cross-origin from
  # rawdemoadmin/rawdemoagent/rawdemostudio and the storefront from rawdemo, so all four are CORS origins, plus the
  # API Gateway front door ($AURL) the demo was first served on.
  DEMO_STORE=https://rawdemo.huecycle.in
  A_PW=$(req /rawaroma/demo/alembic/DB_PASSWORD_app); A_PW=$(enc "$A_PW")
  A_KEYS=$(req /rawaroma/demo/alembic/SECRET_KEYS)
  A_SIGN=$(req /rawaroma/demo/alembic/rawprod-assertion-signing-key)
  A_OWNER_PW=$(req /rawaroma/demo/alembic/DB_PASSWORD_owner); A_OWNER_PW=$(enc "$A_OWNER_PW")
  put /etc/alembic-demo/api.env <<X
ALEMBIC_ENVIRONMENT=demo
DATABASE_URL_APP=postgres://alembic_demo_app:$A_PW@$APG/alembic_demo?sslmode=verify-full
ALEMBIC_TENANT_ID=$TENANT
NODE_EXTRA_CA_CERTS=/etc/alembic/certs/rds-global-bundle.pem
ALEMBIC_DB_CA_FILE=/etc/alembic/certs/rds-global-bundle.pem
ALEMBIC_PUBLIC_WEB_ORIGIN=$AURL
ALEMBIC_CORS_ORIGINS=$DEMO_STORE,https://rawdemoadmin.huecycle.in,https://rawdemoagent.huecycle.in,https://rawdemostudio.huecycle.in,$AURL
ALEMBIC_BEDROCK_REGION=us-west-2
AWS_CONFIG_FILE=/etc/alembic-demo/aws/config
AWS_SHARED_CREDENTIALS_FILE=/etc/alembic-demo/aws/credentials
AWS_SDK_LOAD_CONFIG=1
AWS_EC2_METADATA_DISABLED=true
ALEMBIC_SECRET_KEYS=$A_KEYS
ALEMBIC_RAWPROD_ASSERTION_SIGNING_KEY=$A_SIGN
ALEMBIC_JANITOR_MS=300000
ALEMBIC_LOOPS_MS=900000
ALEMBIC_PUBLIC_ORIGIN=$DEMO_STORE
ALEMBIC_BRIDGE_SWEEP_MS=60000
ALEMBIC_STAFF_MAIL_DROP=/srv/alembic-demo/var/maildrop
ALEMBIC_ACCOUNT_MAIL_DROP=/srv/alembic-demo/var/account-maildrop
ALEMBIC_REF_PREFIX=DEMO
X
  # Build-time origins for ALEMBIC's RawProd console links (deploy-sha.sh takes only NEXT_PUBLIC_* lines from it).
  # Public, and 644 like the file the demo was built with.
  put /etc/alembic-demo/web-build.env <<X
NEXT_PUBLIC_RAWPROD_FACTORY_ORIGIN=https://rawdemofactory.huecycle.in
NEXT_PUBLIC_RAWPROD_PLATFORM_ORIGIN=https://rawdemoplatform.huecycle.in
NEXT_PUBLIC_RAWPROD_VAULT_ORIGIN=https://rawdemovault.huecycle.in
X
  chmod 644 "$E/etc/alembic-demo/web-build.env"
  put /etc/alembic-demo/web.env <<X
RAC_API_INTERNAL=http://127.0.0.1:4010
NODE_ENV=production
X
  put /etc/alembic-demo/migrate.env <<X
DATABASE_URL=postgres://alembic_demo_owner:$A_OWNER_PW@$APG/alembic_demo?sslmode=verify-full
NODE_EXTRA_CA_CERTS=/etc/alembic/certs/rds-global-bundle.pem
PGSSLROOTCERT=/etc/alembic/certs/rds-global-bundle.pem
X
  # Read into variables first (a failed $(g ...) inside a heredoc renders empty instead of failing).
  RP_EXTRA=/etc/rawprod-demo/api.extra.env
  # The app role is granted /rawaroma/demo/vault/DB_PASSWORD_app only, not the KMS key id (not a secret):
  # read it where granted, else carry the value the demo runs with.
  RP_KMS=$(opt FORMULA_KMS_KEY_ID /rawaroma/demo/vault/FORMULA_KMS_KEY_ID /etc/rawprod-demo/api.env "$RP_EXTRA")
  [ -n "$RP_KMS" ] || { echo "render-demo-env: no FORMULA_KMS_KEY_ID in SSM (readable) or on the box" >&2; exit 1; }
  # BRIDGE_HMAC_KEK opens every bridge secret the demo has ALREADY sealed, so a render must give back the KEK the demo
  # runs with, never the one a parameter happens to hold. Live 2026-09-25: the demo runs with the production KEK
  # (/rawaroma/rawprod/bridge-hmac-kek) and /rawaroma/demo/rawprod/bridge-hmac-kek EXISTS WITH A DIFFERENT VALUE --
  # the old "use the demo parameter once it exists" rule would have switched keys on the next render and orphaned
  # every sealed secret. The demo KEK is used only once the box already runs with it (i.e. after the owner re-seals
  # the demo bridge secret under it and switches by hand); otherwise the production KEK, as today.
  RP_KEK_NOW=$(current BRIDGE_HMAC_KEK /etc/rawprod-demo/api.env); [ -n "$RP_KEK_NOW" ] || RP_KEK_NOW=$(current BRIDGE_HMAC_KEK "$RP_EXTRA")
  RP_KEK=$(req /rawaroma/rawprod/bridge-hmac-kek)
  if [ -n "$RP_KEK_NOW" ] && [ "$RP_KEK_NOW" != "$RP_KEK" ] && has_param /rawaroma/demo/rawprod/bridge-hmac-kek; then
    RP_DKEK=$(req /rawaroma/demo/rawprod/bridge-hmac-kek)
    [ "$RP_KEK_NOW" = "$RP_DKEK" ] || { echo "render-demo-env: the demo runs with a BRIDGE_HMAC_KEK that matches neither parameter; refusing to replace it" >&2; exit 1; }
    RP_KEK=$RP_DKEK
  fi
  RP_SHA=$(git_sha /srv/rawprod-demo/app); [ -n "$RP_SHA" ] || RP_SHA=$(current GIT_SHA "$RP_EXTRA")
  # The demo runs WITHOUT an INTERNAL_BRIDGE_KEY (live 2026-09-25, read from the running process), and the demo vault
  # has no INTERNAL_BRIDGE_KEY either. /rawaroma/demo/rawprod/internal-bridge-key now exists, but its mere existence
  # must not turn the internal bridge on for one side only: it is an owner switch, rendered once the box runs with it
  # (set it by hand, then re-render keeps it), never introduced here.
  RP_IBK=""; if [ -n "$(current INTERNAL_BRIDGE_KEY /etc/rawprod-demo/api.env)$(current INTERNAL_BRIDGE_KEY "$RP_EXTRA")" ]; then
    RP_IBK=$(opt INTERNAL_BRIDGE_KEY /rawaroma/demo/rawprod/internal-bridge-key /etc/rawprod-demo/api.env "$RP_EXTRA"); fi
  # RUN_WORKER_IN_PROCESS=true, ALWAYS (RC6, reversing lane cfg-rp's carry-only rule). Without the in-process worker the
  # demo's bridge outbox never drains: on 2026-09-25 201 events were stuck, and the RawProd->ALEMBIC projection and
  # every worker automation were dead. P0 set it live on /etc/rawprod-demo/api.env the same day; a re-render must not
  # take it away again, whatever the box's file says.
  RP_WORKER="RUN_WORKER_IN_PROCESS=true"
  RP_PW=$(req /rawaroma/demo/rawprod/DB_PASSWORD_app); RP_PW=$(enc "$RP_PW")
  RP_JWT=$(req /rawaroma/demo/rawprod/JWT_SECRET)
  RP_VERIFY=$(req /rawaroma/demo/rawprod/assertion-verify-key)
  RP_OWNER_PW=$(req /rawaroma/demo/rawprod/DB_PASSWORD_owner); RP_OWNER_PW=$(enc "$RP_OWNER_PW")
  put /etc/rawprod-demo/api.env <<X
NODE_ENV=production
APP_ENV=prod
RAWPROD_ENVIRONMENT=demo
JWT_ACCESS_TTL=300
PORT=4110
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
DATABASE_URL=postgres://rawprod_demo_app:$RP_PW@$APG/rawprod_demo?sslmode=require
JWT_SECRET=$RP_JWT
ALEMBIC_ASSERTION_ISSUER=alembic
ALEMBIC_ASSERTION_AUDIENCE=rawprod
ALEMBIC_ASSERTION_VERIFY_KEY=$RP_VERIFY
ALEMBIC_ASSERTION_TENANT_ID=$TENANT
RAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform,vault
CORS_ORIGINS=$FURL
AWS_EC2_METADATA_DISABLED=true
$RP_WORKER
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
  rm -f "$E$RP_EXTRA"
  put /etc/rawprod-demo/migrate.env <<X
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
DATABASE_URL=postgres://rawprod_demo_owner:$RP_OWNER_PW@$APG/rawprod_demo?sslmode=require
SKIP_TARGETS=formula
X
  ;;
vault)
  # FORMULA_AUDIT_HMAC_WRAPPED is the KMS-wrapped audit-chain HMAC key. It is written on the box, has no
  # SSM home, and a render that dropped it would make vault-api mint a NEW chain key on the next boot
  # (aws-kms.adapter.ts), so every earlier audit row stops verifying. Carried, never regenerated.
  V_AUDIT=$(opt FORMULA_AUDIT_HMAC_WRAPPED /rawaroma/demo/vault/FORMULA_AUDIT_HMAC_WRAPPED /etc/rawprod-demo/vault.env)
  V_PW=$(req /rawaroma/demo/vault/DB_PASSWORD_app); V_PW=$(enc "$V_PW")
  V_KMS=$(req /rawaroma/demo/vault/FORMULA_KMS_KEY_ID)
  V_JWT=$(req /rawaroma/demo/rawprod/JWT_SECRET)
  V_VERIFY=$(req /rawaroma/demo/rawprod/assertion-verify-key)
  V_FURL=$(req /rawaroma/demo/factory-url)
  V_OWNER_PW=$(req /rawaroma/demo/vault/DB_PASSWORD_owner); V_OWNER_PW=$(enc "$V_OWNER_PW")
  # INTERNAL_BRIDGE_KEY: the same owner switch as the app side (see RP_IBK). The demo vault runs
  # without one today; once the owner sets it by hand (the SAME value as the demo app's), a
  # re-render keeps it (from SSM where this role may read it, else the box's own value). Before
  # lane fread-rp this heredoc had no such line, so a re-render silently turned the demo's signed
  # main -> vault channel off again (pick lists, dashboard labels, the material picker's catalogue).
  V_IBK=""; if [ -n "$(current INTERNAL_BRIDGE_KEY /etc/rawprod-demo/vault.env)" ]; then
    V_IBK=$(opt INTERNAL_BRIDGE_KEY /rawaroma/demo/rawprod/internal-bridge-key /etc/rawprod-demo/vault.env); fi
  put /etc/rawprod-demo/vault.env <<X
NODE_ENV=production
APP_ENV=prod
RAWPROD_ENVIRONMENT=demo
JWT_ACCESS_TTL=300
PORT=4111
VAULT_MODE=true
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
FORMULA_DATABASE_URL=postgres://vault_demo_app:$V_PW@$VPG/vault_demo?sslmode=require
FORMULA_KMS_KEY_ID=$V_KMS
FORMULA_KMS_REGION=us-west-2
AWS_CONFIG_FILE=/etc/rawprod-demo/aws/config
AWS_SHARED_CREDENTIALS_FILE=/etc/rawprod-demo/aws/credentials
AWS_SDK_LOAD_CONFIG=1
AWS_EC2_METADATA_DISABLED=true
# P0 decision (2026-09-24, lane FIXV): mirrors prod's render-env.sh — vault-api verifies
# RawProd-issued JWTs, so it MUST use the SAME signing key as rawprod-demo's api.env. Reads the
# demo rawprod JWT_SECRET param directly; /rawaroma/demo/vault/JWT_SECRET is retired.
JWT_SECRET=$V_JWT
ALEMBIC_ASSERTION_ISSUER=alembic
ALEMBIC_ASSERTION_AUDIENCE=rawprod
ALEMBIC_ASSERTION_VERIFY_KEY=$V_VERIFY
RAWPROD_ASSERTION_EXPECTED_TARGETS=vault
# The factory front door, and the public demo Vault console (infra/aws/nginx/rawdemovault.conf).
CORS_ORIGINS=$V_FURL,https://rawdemovault.huecycle.in
$V_AUDIT
$V_IBK
X
  put /etc/rawprod-demo/vault-migrate.env <<X
PGSSLROOTCERT=/etc/rawprod/rds-global-bundle.pem
FORMULA_DATABASE_URL=postgres://vault_demo_owner:$V_OWNER_PW@$VPG/vault_demo?sslmode=require
SKIP_TARGETS=main
X
  # demo vault-api runs as role rawprod-vault-demo (the only principal the demo envelope key allows). H1: the old
  # /etc/rawprod-demo/aws-config (credential_source=Ec2InstanceMetadata) is retired — the demo process reached IMDS
  # and so could mint the PROD box role. The session now comes from demo-aws-creds.sh vault (root timer).
  rm -f "$E/etc/rawprod-demo/aws-config"
  chmod 755 "$E/etc/rawprod-demo"
  ;;
esac
