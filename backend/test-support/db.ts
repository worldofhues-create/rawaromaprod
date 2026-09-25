/**
 * RP-FAC test-support — real-Postgres harness for the factory-sm state-machine tests. Points at
 * a throwaway database (own DB, own lane, per the lane rules — never the app's dev/prod DB) and
 * applies schema.sql (idempotent `create table if not exists`) once per process. Tests get real
 * Drizzle clients over the actual cluster schemas so `SELECT ... FOR UPDATE` locking, unique
 * constraints, and transaction rollback all behave exactly as they do in production — this is
 * deliberately NOT a mock; the whole point of the concurrency tests is that a fake db can't lie
 * about lock contention the way a real one can't.
 *
 *   TEST_DATABASE_URL=postgres://apple@localhost:5432/rawprod_rp_policy_test (default)
 *
 * F8 (lane rp-policy): this is lane F8's OWN database (rp_policy), never shared with lane F's
 * factory_sm, lane F2's factory_sm2, lane F3's rp_proc, lane F4's mixabort, lane F5's
 * rp_deadtables, lane F6's rp_emit, lane F7's rp_r1b, or any other lane's throwaway test DB —
 * per the parallel-lane rule, two lanes never share a test DB, and the schema-application
 * advisory lock below gets its own key so it can't collide with another lane's concurrent test
 * run against a different DB on the same Postgres instance (commit 4e8622a's pattern).
 */
import { createHash, randomUUID } from 'node:crypto';
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
import * as orgSchema from '@ra/data-org';
import type { AuthPrincipal } from '../backend-kernel/src/edge/principal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_rp_policy_test';

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
      // Arbitrary fixed lock key for "the rp-policy (lane F8) test schema" — distinct from other
      // lanes' keys (e.g. lane F7's r1b key 392847561).
      await sql`select pg_advisory_lock(819273645)`;
      try {
        // R1B (extended, C-item): skip re-applying schema.sql once some OTHER process has already
        // applied THIS EXACT schema.sql content. Before the R1B fix, EVERY test-file process
        // re-ran the whole script every time — harmless in principle (every statement is
        // `IF NOT EXISTS`/idempotent), but each `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` still
        // takes an ACCESS EXCLUSIVE lock on that table to check, even when the column is already
        // there; with dozens of test files racing this, a later process's ALTER could queue
        // behind an already-running process's open transaction on the same table and hit a
        // genuine Postgres deadlock. R1B's fix was a single completion sentinel
        // (`to_regclass('bridge.connector_config')`, the last table the script creates) — but on
        // a REUSED database from an older checkout, that sentinel is already satisfied from a
        // prior run, so a schema.sql that has since grown new tables/columns never gets applied
        // at all (13 failures seen from exactly this — tables added after the sentinel table was
        // introduced silently never reached a reused test DB). Track a content hash of
        // schema.sql instead of one fixed table's existence: a DB last brought up to date by an
        // OLDER schema.sql (different hash) always gets the (idempotent, safe-to-rerun) DDL
        // reapplied, which creates whatever is new since; a DB already current for the exact
        // content running now is skipped, preserving the original lock-contention fix.
        const ddl = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
        const hash = createHash('sha256').update(ddl).digest('hex');
        await sql.unsafe(
          `create table if not exists public._test_schema_applied (
             hash varchar(64) primary key,
             applied_dt timestamptz not null default now()
           )`,
        );
        const [applied] = await sql<{ hash: string }[]>`
          select hash from public._test_schema_applied where hash = ${hash}
        `;
        if (!applied) {
          await sql.unsafe(ddl);
          await sql`
            insert into public._test_schema_applied (hash) values (${hash})
            on conflict (hash) do nothing
          `;
        }
      } finally {
        await sql`select pg_advisory_unlock(819273645)`;
      }
    })();
  }
  return ready;
}

/**
 * A masterdata material with its floor code (RM alias), for tests that create production orders:
 * the Vault's coded pick list names each line by its RM_ALIAS reference, and PlanningService maps
 * that back to the material row. Returns the three ids/names a `CodedPickLine` stub needs.
 */
export async function materialWithAlias(): Promise<{ materialId: string; rmAliasId: string; aliasName: string }> {
  const sql = testClient();
  const materialId = randomUUID();
  const rmAliasId = randomUUID();
  const aliasName = `RM-${materialId.slice(0, 8)}`;
  await sql`insert into masterdata.material (material_id, material_code, material_name, status)
            values (${materialId}, ${`MAT-${materialId.slice(0, 8)}`}, 'Test material', 'ACTIVE')`;
  await sql`insert into masterdata.rm_alias (rm_alias_id, material_id, alias_name, alias_type, status)
            values (${rmAliasId}, ${materialId}, ${aliasName}, 'FLOOR_CODE', 'ACTIVE')`;
  return { materialId, rmAliasId, aliasName };
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

export function orgDb(): PostgresJsDatabase<typeof orgSchema> {
  return drizzle(testClient(), { schema: orgSchema });
}

export {
  productionSchema,
  packagingSchema,
  salesSchema,
  inventorySchema,
  qualitySchema,
  procurementSchema,
  bridgeSchema,
  orgSchema,
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
    // Default = "now" so a test that doesn't care about staleness passes any @FreshAuth check
    // too; a test asserting the step-up gate overrides this to an old value.
    iat: Math.floor(Date.now() / 1000),
    // FreshAuthGuard reads authTime, not iat (S3 security review item 2) — default it to the
    // same "now" so a test that only overrides `iat` (pre-existing callers) still passes any
    // @FreshAuth check by default; a step-up test overrides authTime explicitly.
    authTime: Math.floor(Date.now() / 1000),
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
