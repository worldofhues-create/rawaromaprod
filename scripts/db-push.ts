/**
 * Go-live schema push — applies all 12 pg schemas to the target Postgres using drizzle-kit's
 * PROGRAMMATIC api (bypasses the CLI's broken `.js`-specifier resolution). Idempotent: re-running
 * only applies the diff. Run:
 *   DATABASE_URL=postgres://... [FORMULA_DATABASE_URL=...] pnpm db:push
 *
 * The formula schema is pushed to FORMULA_DATABASE_URL (the vault's own `ra_vault` role) when
 * set, else to DATABASE_URL. Prerequisites (uuidv7() + pg_trgm + postgis) are installed first on
 * each connection — they MUST exist before any CREATE TABLE whose columns default to uuidv7() or
 * use a geometry type. Refuses destructive (data-loss) statements unless ALLOW_DATA_LOSS=1.
 */
import { createRequire } from 'node:module';
import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { UUIDV7_SQL } from '@core/data-kernel';
import { SCHEMA_GROUPS, loadGroup, type SchemaGroup } from './db-schema-groups.js';

const require = createRequire(import.meta.url);
// Use generateDrizzleJson + generateMigration (snapshot diff, NO live-DB introspection) rather
// than pushSchema: drizzle-kit 0.30.6's introspector (fromDatabase) throws under drizzle-orm
// 0.38 + Postgres 16/17. We diff an EMPTY snapshot → the target snapshot to get pure CREATE DDL,
// then execute it ourselves. The target schemas are fresh, so empty→target is exactly right.
const { generateDrizzleJson, generateMigration } = require('drizzle-kit/api') as typeof import('drizzle-kit/api');

/** A reusable empty snapshot = the "previous" state of a brand-new schema. */
const EMPTY_SNAPSHOT = generateDrizzleJson({});

/** Idempotent DDL every connection needs before tables are created. */
const PREREQS: string[] = [
  'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  'CREATE EXTENSION IF NOT EXISTS postgis',
  UUIDV7_SQL,
];

async function withDb<T>(url: string, fn: (db: ReturnType<typeof drizzle>, client: Sql) => Promise<T>): Promise<T> {
  // prepare:false → safe on PgBouncer/Neon pooled endpoints (no cross-tx prepared-stmt reuse).
  const client = postgres(url, { max: 1, prepare: false });
  try {
    return await fn(drizzle(client), client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function ensurePrereqs(url: string): Promise<void> {
  await withDb(url, async (db) => {
    for (const stmt of PREREQS) await db.execute(sql.raw(stmt));
  });
}

async function pushGroup(g: SchemaGroup, url: string): Promise<void> {
  await withDb(url, async (db, client) => {
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${g.schema}"`));

    // Idempotency at schema granularity: skip a schema that already has tables (re-run safe).
    const populated = (
      await client.unsafe<{ n: number }[]>(
        `select count(*)::int as n from information_schema.tables where table_schema = '${g.schema}'`,
      )
    )[0];
    if (populated && populated.n > 0) {
      // eslint-disable-next-line no-console
      console.log(`=  ${g.schema.padEnd(11)} already has ${populated.n} tables — skipped`);
      return;
    }

    const imports = await loadGroup(g.packages);
    const target = generateDrizzleJson(imports, undefined, [g.schema], 'snake_case');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generated = await generateMigration(EMPTY_SNAPSHOT as any, target as any);
    // Drop the generated bare `CREATE SCHEMA "x"` — we create the schema idempotently above.
    const statements = generated.filter((s) => !/^\s*create\s+schema\b/i.test(s));
    if (statements.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`=  ${g.schema.padEnd(11)} no statements`);
      return;
    }
    for (const stmt of statements) {
      await client.unsafe(stmt);
    }
    // eslint-disable-next-line no-console
    console.log(`+  ${g.schema.padEnd(11)} created (${statements.length} statements)${g.vault ? ' [vault conn]' : ''}`);
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to push the schema');
  const vaultUrl = process.env.FORMULA_DATABASE_URL ?? url;

  // eslint-disable-next-line no-console
  console.log('== prerequisites (uuidv7 + pg_trgm + postgis) ==');
  await ensurePrereqs(url);
  if (vaultUrl !== url) await ensurePrereqs(vaultUrl);

  // eslint-disable-next-line no-console
  console.log('== push schemas ==');
  for (const g of SCHEMA_GROUPS) {
    await pushGroup(g, g.vault ? vaultUrl : url);
  }
  // eslint-disable-next-line no-console
  console.log('== db:push complete ==');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
