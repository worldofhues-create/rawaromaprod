/**
 * Lane U4's own throwaway Postgres harness for the formula (Vault) schema — mirrors
 * `backend/test-support/db.ts`'s shape (shared connection, advisory-lock-serialized one-time
 * schema apply, `closeTestClient`), but scoped to ONE schema instead of the whole app, and
 * pushed via drizzle-kit's programmatic API the same way `scripts/db-push.ts` pushes each
 * schema group — NOT by running db-push.ts itself, which pushes all 13 schema groups
 * (including `location`, which needs the `postgis` extension; unavailable in every dev/CI
 * box) and would make every Vault test depend on infrastructure this lane doesn't need.
 *
 * Per the parallel-lane rule (one agent = one worktree/branch/DB), this is lane U4's OWN
 * database — never `rawprod_rp_policy_test` (lane F8) or any other lane's throwaway DB.
 *
 *   FORMULA_TEST_DATABASE_URL=postgres://... (default: TEST_DATABASE_URL if set, else
 *   rawprod_u4_vault_test) — the C-item fix: previously an unset FORMULA_TEST_DATABASE_URL
 *   silently fell back to the hardcoded rawprod_u4_vault_test default even when the caller
 *   only set TEST_DATABASE_URL (e.g. per the S2 test-run instructions), pointing this harness
 *   at a DIFFERENT database than the one actually being prepared/reused.
 */
import { createRequire } from 'node:module';
import postgres, { type Sql } from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { UUIDV7_SQL } from '@core/data-kernel';
import * as formulaSchema from '@ra/data-formula';

const require = createRequire(import.meta.url);
// Same reason as scripts/db-push.ts: drizzle-kit 0.30.6's live-DB introspector throws under
// drizzle-orm 0.38 + Postgres 16/17, so we diff an EMPTY snapshot -> the formula schema's
// target snapshot (pure CREATE DDL for a schema we know is fresh) and execute that ourselves.
const { generateDrizzleJson, generateMigration } = require('drizzle-kit/api') as typeof import('drizzle-kit/api');

export const TEST_DATABASE_URL =
  process.env.FORMULA_TEST_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgres://apple@localhost:5432/rawprod_u4_vault_test';

let client: Sql | undefined;
let ready: Promise<void> | undefined;

/** One shared connection for the whole test run. */
export function testClient(): Sql {
  if (!client) client = postgres(TEST_DATABASE_URL, { max: 5, prepare: false });
  return client;
}

/** Push the `formula` schema exactly once per process (advisory-lock serialized across the
 * files `pnpm test` runs in parallel — same pattern as backend/test-support/db.ts). */
export async function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const sql = testClient();
      // Arbitrary fixed lock key for "lane U4's formula-schema test DB" — distinct from
      // other lanes' keys (rp-policy's 819273645, r1b's 392847561, …).
      await sql`select pg_advisory_lock(481027365591)`;
      try {
        const [sentinel] = await sql<{ done: string | null }[]>`select to_regclass('formula.audit_events') as done`;
        if (!sentinel?.done) {
          await sql.unsafe(UUIDV7_SQL);
          await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "formula"`);
          const empty = generateDrizzleJson({});
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const target = generateDrizzleJson(formulaSchema as any, undefined, ['formula'], 'snake_case');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const generated = await generateMigration(empty as any, target as any);
          const statements = generated.filter((s) => !/^\s*create\s+schema\b/i.test(s));
          for (const stmt of statements) await sql.unsafe(stmt);
        }
      } finally {
        await sql`select pg_advisory_unlock(481027365591)`;
      }
    })();
  }
  return ready;
}

export function formulaDb(): PostgresJsDatabase<typeof formulaSchema> {
  return drizzle(testClient(), { schema: formulaSchema });
}

export async function closeTestClient(): Promise<void> {
  if (client) {
    await client.end({ timeout: 1 });
    client = undefined;
    ready = undefined;
  }
}
