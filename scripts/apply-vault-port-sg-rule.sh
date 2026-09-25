#!/usr/bin/env bash
# PB-03 remainder (V4 §109.1) — VaultPort's inbound SG rule. WRITTEN FOR P0 TO REVIEW AND RUN.
# NOT executed by any lane, any CI job, or this script's own invocation without --apply: this
# is exactly the "write the SG change as a script for P0, don't apply" deliverable.
#
# WHAT THIS OPENS AND WHY: `backend/api/src/vault-port.ts`'s `VaultPortHttpClient` (the main app
# box's ProductionModule, via `VaultPortModule`) calls `VAULT_API_INTERNAL_URL` +
# `/internal/vault/resolve-manufacturing-instruction` to resolve a coded manufacturing
# instruction from the Vault box instead of decrypting locally. That call needs a network path
# from the app box to the Vault box's vault-api process — today there is NONE:
# `infra/aws/PROVISIONED.md` records SG `sg-09345a5b4efc3ce65` (`rawprod-vault-app`, attached to
# the standalone Vault EC2) as having "NO inbound rules. Operators reach the box through SSM
# only." This script adds exactly one: TCP on vault-api's port (4100, matching
# `infra/aws/nginx/vault.conf`'s `upstream vault_api { server 127.0.0.1:4100; }` and both boxes'
# shared `PORT=` convention), sourced from the app box's OWN security group (resolved by name —
# PROVISIONED.md records the app box, i-04e7dc4e5edcc1ff7, as using "the existing SGs
# (alembic-web to alembic-db)" — never a bare IP/CIDR, so the rule tracks the app box even if
# its private IP changes on restart).
#
# There is NO Vault -> main app box direction and no rule for one (lane fread-rp): the Vault
# console's material picker is fed by a catalogue the main box PUSHES over this same port, so the
# app box's own SG stays closed to the Vault box. (The retired `MaterialFactsClient` path assumed
# the Vault could reach the main API's /internal/ routes through the public listener; nginx never
# proxied /internal/, so it never worked.) The demo pair uses the same rule on port 4111
# (VAULT_PORT_INTERNAL_PORT=4111), which rawdemovault.conf's upstream already relies on.
#
# SAFE BY CONSTRUCTION, NOT JUST BY CONVENTION:
#   - refuses to run without --apply (dry-run prints the exact `aws` command and exits 0)
#   - resolves the source SG BY NAME at run time (never hardcodes an IP/CIDR that can drift)
#   - idempotent: `authorize-security-group-ingress` on an already-present rule is a documented
#     no-op error (InvalidPermission.Duplicate) this script treats as success, not a failure
#   - touches ONLY sg-09345a5b4efc3ce65 (rawprod-vault-app) — never alembic-web, alembic-db, or
#     any CloudFront/API Gateway resource (out of this lane's scope entirely)
#
# Usage:
#   scripts/apply-vault-port-sg-rule.sh                 # dry run (default, always safe)
#   scripts/apply-vault-port-sg-rule.sh --apply          # actually calls the AWS API — P0 only
#
# Override points (all optional; defaults match infra/aws/PROVISIONED.md as recorded 2026-09-24):
#   VAULT_APP_SG_ID          (default: sg-09345a5b4efc3ce65, `rawprod-vault-app`)
#   APP_BOX_SG_NAME          (default: alembic-web — resolved to an id via describe-security-groups)
#   VAULT_PORT_INTERNAL_PORT (default: 4100 — vault-api's listen port, both directions of this
#                              bridge share the one public-facing port; no second port to open)
#   AWS_REGION               (default: us-west-2, per PROVISIONED.md)
#   AWS_PROFILE              (default: unset — uses the caller's default profile/credentials)

set -euo pipefail

VAULT_APP_SG_ID="${VAULT_APP_SG_ID:-sg-09345a5b4efc3ce65}"
APP_BOX_SG_NAME="${APP_BOX_SG_NAME:-alembic-web}"
VAULT_PORT_INTERNAL_PORT="${VAULT_PORT_INTERNAL_PORT:-4100}"
AWS_REGION="${AWS_REGION:-us-west-2}"
APPLY=false

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

AWS_ARGS=(--region "$AWS_REGION")
if [[ -n "${AWS_PROFILE:-}" ]]; then
  AWS_ARGS+=(--profile "$AWS_PROFILE")
fi

echo "Resolving source security group by name: $APP_BOX_SG_NAME ..." >&2
APP_BOX_SG_ID="$(
  aws ec2 describe-security-groups "${AWS_ARGS[@]}" \
    --filters "Name=group-name,Values=${APP_BOX_SG_NAME}" \
    --query 'SecurityGroups[0].GroupId' --output text
)"

if [[ -z "$APP_BOX_SG_ID" || "$APP_BOX_SG_ID" == "None" ]]; then
  echo "Could not resolve a security group named '$APP_BOX_SG_NAME' in region $AWS_REGION." >&2
  echo "Set APP_BOX_SG_NAME (or edit this script) to the app box's actual SG name/id." >&2
  exit 1
fi

echo "Resolved: $APP_BOX_SG_NAME -> $APP_BOX_SG_ID" >&2

CMD=(aws ec2 authorize-security-group-ingress "${AWS_ARGS[@]}"
  --group-id "$VAULT_APP_SG_ID"
  --protocol tcp
  --port "$VAULT_PORT_INTERNAL_PORT"
  --source-group "$APP_BOX_SG_ID")

echo "This will run:" >&2
printf '  %q' "${CMD[@]}" >&2
echo >&2

if [[ "$APPLY" != true ]]; then
  echo >&2
  echo "DRY RUN (default) — nothing was changed. Re-run with --apply to actually open this port." >&2
  echo "This script is for P0 to run after reviewing it, not for any lane to run itself." >&2
  exit 0
fi

echo "Applying (--apply was passed)..." >&2
if ! OUTPUT="$("${CMD[@]}" 2>&1)"; then
  if echo "$OUTPUT" | grep -q "InvalidPermission.Duplicate"; then
    echo "Rule already present (InvalidPermission.Duplicate) — treating as success (idempotent)." >&2
    exit 0
  fi
  echo "$OUTPUT" >&2
  exit 1
fi
echo "$OUTPUT"
echo "Done: $VAULT_APP_SG_ID now accepts TCP/$VAULT_PORT_INTERNAL_PORT from $APP_BOX_SG_ID ($APP_BOX_SG_NAME)." >&2
