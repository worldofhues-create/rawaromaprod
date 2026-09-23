#!/usr/bin/env bash
# Go-live: provision the full schema + bootstrap seed against the target Postgres.
# Idempotent — safe to re-run after each deploy (including against a database that already has
# an older schema on it: see PB-16 / scripts/db-migrate.ts). Requires DATABASE_URL (and, for the
# vault's own role, FORMULA_DATABASE_URL) plus BOOTSTRAP_OWNER_PASSWORD for the seed.
#
# PB-16: `pnpm db:migrate` is now the canonical schema provisioner — scripts/migrations/*.sql,
# ordered and idempotent, regenerated from the same Drizzle definitions the old `db:push` path
# read (scripts/gen-schema-migrations.mjs) plus every ad-hoc create-*.cjs script's DDL. It is a
# proven superset of `db:push` on an empty database and, unlike `db:push` (create-once — skips a
# schema outright once it has any table), also brings an already-populated database up to the
# current full schema. This is what production actually runs (ops/systemd/rawprod-migrate.service
# / infra/aws/deploy.sh); `db:push` remains for local/dev convenience only.
set -euo pipefail

echo "== db:migrate — canonical schema (0000..NNNN, idempotent, ordered) =="
pnpm db:migrate

echo "== db:seed — permissions + owner role + bootstrap owner login =="
pnpm db:seed

echo "== migrate-all done — POST /auth/login with the owner email + BOOTSTRAP_OWNER_PASSWORD =="
