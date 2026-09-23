/**
 * PB-03 / SB-01 — `assertMainRoleCannotReadVault` against REAL Postgres (lane vk's own
 * throwaway `formula` schema — reuses `backend/cluster-formula/src/__tests__/db.ts`'s harness
 * so this exercises the SAME tables `scripts/provision-vault-isolation.sql` targets, not a
 * hand-rolled stand-in).
 *
 * Two real roles, two real outcomes:
 *   - the SCHEMA-OWNING role (the one `ensureSchema()` ran as) can trivially read
 *     formula.formula_vault/formula_ingredients — proves the check correctly FLAGS the
 *     unhealthy "wall is down" case (this is exactly what a not-yet-isolated main app role
 *     looks like before scripts/provision-vault-isolation.sql is applied).
 *   - a FRESH low-privilege role with no grants on the `formula` schema at all (Postgres
 *     grants nothing beyond the owner by default on a new schema) cannot read either table —
 *     proves the check passes cleanly once isolation actually holds.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import postgres, { type Sql } from 'postgres';
import { assertMainRoleCannotReadVault } from '../vault-isolation-check.js';
import { ensureSchema, testClient, closeTestClient, TEST_DATABASE_URL } from '../../../cluster-formula/src/__tests__/db.js';

const LOW_PRIV_ROLE = 'vk_isolation_test_role';
const LOW_PRIV_PASSWORD = 'vk_isolation_test_pw';

let lowPrivClient: Sql | undefined;

before(async () => {
  await ensureSchema();
  const sql = testClient();
  // Idempotent: safe to re-run this test file without a prior DROP ROLE.
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOW_PRIV_ROLE}') THEN
        CREATE ROLE ${LOW_PRIV_ROLE} LOGIN PASSWORD '${LOW_PRIV_PASSWORD}';
      END IF;
    END
    $$;
  `);
  // Grant CONNECT only — deliberately NOT USAGE on the formula schema, so this role is the
  // "isolation holds" stand-in: it can reach the database but not the formula schema's tables.
  const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
  await sql.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO ${LOW_PRIV_ROLE}`);
});

afterAll(async () => {
  await lowPrivClient?.end({ timeout: 1 });
  await closeTestClient();
});

test('assertMainRoleCannotReadVault: THROWS when the connection CAN read formula_vault/formula_ingredients (isolation wall down)', async () => {
  // The schema-owning role (whatever ran ensureSchema — typically the DB's default/superuser
  // role in this local harness) can read both tables outright: the unhealthy case.
  await assert.rejects(() => assertMainRoleCannotReadVault(testClient()), /Vault isolation violated/);
});

test('assertMainRoleCannotReadVault: RESOLVES cleanly when the connection has no grant on the formula schema (isolation wall holds)', async () => {
  const url = new URL(TEST_DATABASE_URL);
  url.username = LOW_PRIV_ROLE;
  url.password = LOW_PRIV_PASSWORD;
  lowPrivClient = postgres(url.toString(), { max: 1, prepare: false });

  await assert.doesNotReject(() => assertMainRoleCannotReadVault(lowPrivClient!));
});
