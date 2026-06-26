#!/usr/bin/env bash
# Go-live: provision the full schema + bootstrap seed against the target Postgres (Neon).
# Idempotent — safe to re-run after each deploy. Requires DATABASE_URL (and, for the vault's
# own role, FORMULA_DATABASE_URL) plus BOOTSTRAP_OWNER_PASSWORD for the seed.
#
# Uses the PROGRAMMATIC drizzle-kit api (scripts/db-push.ts) instead of the drizzle-kit CLI,
# which cannot resolve the NodeNext `.js` import specifiers in the schema barrels. All 12 pg
# schemas (185 tables) are pushed; the formula schema goes to FORMULA_DATABASE_URL when set.
set -euo pipefail

echo "== db:push — all 12 schemas (185 tables) =="
pnpm db:push

echo "== db:seed — permissions + owner role + bootstrap owner login =="
pnpm db:seed

echo "== migrate-all done — POST /auth/login with the owner email + BOOTSTRAP_OWNER_PASSWORD =="
