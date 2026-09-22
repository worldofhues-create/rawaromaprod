/**
 * RP-FAC test-support — real-Postgres harness for the factory-sm state-machine tests. Points at
 * a throwaway database (own DB, own lane, per the lane rules — never the app's dev/prod DB) and
 * applies schema.sql (idempotent `create table if not exists`) once per process. Tests get real
 * Drizzle clients over the actual cluster schemas so `SELECT ... FOR UPDATE` locking, unique
 * constraints, and transaction rollback all behave exactly as they do in production — this is
 * deliberately NOT a mock; the whole point of the concurrency tests is that a fake db can't lie
 * about lock contention the way a real one can't.
 *
 *   TEST_DATABASE_URL=postgres://apple@localhost:5432/rawprod_rp_r1b_test (default)
 *
 * R1B (lane F7): this is lane F7's OWN database (rp_r1b), never shared with lane F's
 * factory_sm, lane F2's factory_sm2, lane F3's rp_proc, lane F4's mixabort, lane F5's
 * rp_deadtables, lane F6's rp_emit, or any other lane's throwaway test DB.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as productionSchema from '@ra/data-production';
import * as packagingSchema from '@ra/data-packaging';
import * as salesSchema from '@ra/data-sales';
import * as inventorySchema from '@ra/data-inventory';
import * as qualitySchema from '@ra/data-quality';
import * as procurementSchema from '@ra/data-procurement';
import * as bridgeSchema from '@ra/data-bridge';
import type { AuthPrincipal } from '../backend-kernel/src/edge/principal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_rp_r1b_test';

let client: Sql | undefined;
let ready: Promise<void> | undefined;

/** One shared connection for the whole test run; schema.sql applied exactly once (idempotent anyway). */
export function testClient(): Sql {
  if (!client) client = postgres(TEST_DATABASE_URL, { max: 5, prepare: false });
  return client;
}

// RP-FAC2: each *.test.ts file is its own node:test process (confirmed — the schema-application
// race below only reproduces against a genuinely fresh database with many files), so the
// in-process `ready` promise dedupes concurrent ensureSchema() calls WITHIN one file but not
// ACROSS the ~10 files pnpm test now runs in parallel. Postgres's own `IF NOT EXISTS` on
// `CREATE EXTENSION`/`CREATE SCHEMA`/`CREATE TABLE` is not safe against true concurrent creators
// (a second session's existence check can pass before the first's commit, then both try to
// insert the same catalog row) — on a fresh DB this reliably threw duplicate-key errors
// (pg_extension_name_index) once enough files raced it at once. A session-level advisory lock
// serializes the DDL across processes: whichever process gets there first applies the whole
// schema.sql while every other process's ensureSchema() blocks on the lock, then finds
// everything already created.
export async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const sql = testClient();
      // Arbitrary fixed lock key for "the r1b (lane F7) test schema" — distinct from other lanes' keys.
      await sql`select pg_advisory_lock(392847561)`;
      try {
        // R1B: skip re-applying schema.sql once some OTHER process has already fully applied
        // it. Before this check, EVERY test-file process re-ran the whole script — harmless in
        // principle (every statement is `IF NOT EXISTS`/idempotent), but each `ALTER TABLE ...
        // ADD COLUMN IF NOT EXISTS` still takes an ACCESS EXCLUSIVE lock on that table to check,
        // even when the column is already there. With dozens of test files starting up and
        // racing this (only one applies at a time thanks to the advisory lock, but each of the
        // REST still pays that lock cost serially, once each), a later process's ALTER could
        // queue behind an already-running process's open transaction on the same table (e.g. a
        // concurrency test's row lock) and hit a genuine Postgres deadlock — reproduced in this
        // lane's own test suite once enough files/tests were added. `bridge.connector_config` is
        // the LAST table schema.sql creates, and `sql.unsafe(ddl)`'s multi-statement string runs
        // as one implicit transaction (Postgres's simple-query protocol), so its existence means
        // the entire script already committed — safe to treat as a completion sentinel.
        const [sentinel] = await sql<{ done: string | null }[]>`select to_regclass('bridge.connector_config') as done`;
        if (!sentinel?.done) {
          const ddl = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
          await sql.unsafe(ddl);
        }
      } finally {
        await sql`select pg_advisory_unlock(392847561)`;
      }
    })();
  }
  return ready;
}

export function productionDb(): PostgresJsDatabase<typeof productionSchema> {
  return drizzle(testClient(), { schema: productionSchema });
}

export function packagingDb(): PostgresJsDatabase<typeof packagingSchema> {
  return drizzle(testClient(), { schema: packagingSchema });
}

export function salesDb(): PostgresJsDatabase<typeof salesSchema> {
  return drizzle(testClient(), { schema: salesSchema });
}

export function inventoryDb(): PostgresJsDatabase<typeof inventorySchema> {
  return drizzle(testClient(), { schema: inventorySchema });
}

export function qualityDb(): PostgresJsDatabase<typeof qualitySchema> {
  return drizzle(testClient(), { schema: qualitySchema });
}

export function procurementDb(): PostgresJsDatabase<typeof procurementSchema> {
  return drizzle(testClient(), { schema: procurementSchema });
}

export function bridgeDb(): PostgresJsDatabase<typeof bridgeSchema> {
  return drizzle(testClient(), { schema: bridgeSchema });
}

export {
  productionSchema,
  packagingSchema,
  salesSchema,
  inventorySchema,
  qualitySchema,
  procurementSchema,
  bridgeSchema,
};

/** A minimal AuthPrincipal fixture. `roles`/`permissions` let a test exercise the RBAC guard too. */
export function principal(overrides: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return {
    userId: '00000000-0000-7000-8000-000000000001',
    portal: 'ops' as AuthPrincipal['portal'],
    roles: ['production_operator'],
    permissions: [
      'production:oil_batch_master:write',
      'production:oil_batch_master:read',
      'production:production_qc:write',
      'packaging:finished_good_batch_master:write',
      'packaging:finished_good_batch_master:read',
      'sales:dispatch_master:write',
      'sales:dispatch_master:read',
      'sales:dispatch_items:write',
      'sales:dispatch_items:read',
    ],
    permVersion: 1,
    sessionId: '00000000-0000-7000-8000-0000000000ff',
    ...overrides,
  };
}

export async function closeTestClient(): Promise<void> {
  if (client) {
    await client.end({ timeout: 1 });
    client = undefined;
    ready = undefined;
  }
}
