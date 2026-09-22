/**
 * RP-FAC test-support — real-Postgres harness for the factory-sm state-machine tests. Points at
 * a throwaway database (own DB, own lane, per the lane rules — never the app's dev/prod DB) and
 * applies schema.sql (idempotent `create table if not exists`) once per process. Tests get real
 * Drizzle clients over the actual cluster schemas so `SELECT ... FOR UPDATE` locking, unique
 * constraints, and transaction rollback all behave exactly as they do in production — this is
 * deliberately NOT a mock; the whole point of the concurrency tests is that a fake db can't lie
 * about lock contention the way a real one can't.
 *
 *   TEST_DATABASE_URL=postgres://apple@localhost:5432/rawprod_factory_sm_test (default)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as productionSchema from '@ra/data-production';
import * as packagingSchema from '@ra/data-packaging';
import * as salesSchema from '@ra/data-sales';
import type { AuthPrincipal } from '../backend-kernel/src/edge/principal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_factory_sm_test';

let client: Sql | undefined;
let ready: Promise<void> | undefined;

/** One shared connection for the whole test run; schema.sql applied exactly once (idempotent anyway). */
export function testClient(): Sql {
  if (!client) client = postgres(TEST_DATABASE_URL, { max: 5, prepare: false });
  return client;
}

export async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const sql = testClient();
      const ddl = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
      await sql.unsafe(ddl);
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

export { productionSchema, packagingSchema, salesSchema };

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
