#!/usr/bin/env node
/**
 * PB-16 — regenerates scripts/migrations/0001..0013_<schema>.sql from the SAME drizzle-kit
 * programmatic diff that scripts/db-push.ts uses (generateDrizzleJson + generateMigration,
 * empty snapshot -> per-schema-group target). This is a DEV TOOL, run by a human/CI when the
 * Drizzle table definitions in packages/data-* change — it is not part of the deploy path.
 * db:migrate (scripts/db-migrate.ts) is what runs in production, against the checked-in .sql
 * files this script writes; it never imports drizzle-kit or the schema packages at deploy time.
 *
 * Why generate rather than hand-write: 194 tables across 13 pg schemas is not something a
 * person transcribes correctly, and "the migration file matches the Drizzle model" is exactly
 * the property db-push.ts already guarantees at runtime. Generating the SQL once and committing
 * it turns that runtime guarantee into a reviewable, ordered, idempotent artifact — the same
 * move node-pg-migrate / Alembic-the-migration-tool make, applied to a Drizzle source of truth.
 *
 * Idempotency transform (generateMigration's raw output is an empty->target diff — CREATE TABLE
 * with the table's FULL current column list, CREATE INDEX, ALTER TABLE ADD CONSTRAINT — correct
 * for a table that does not exist yet, but not for one that does):
 *   CREATE SCHEMA "x"                       -> CREATE SCHEMA IF NOT EXISTS "x"
 *   CREATE TABLE "s"."t" (...)              -> CREATE TABLE IF NOT EXISTS "s"."t" (...)
 *   CREATE [UNIQUE] INDEX "n" ON ...        -> CREATE [UNIQUE] INDEX IF NOT EXISTS "n" ON ...
 *   ALTER TABLE ... ADD CONSTRAINT "n" ...  -> wrapped in DO $$ ... EXCEPTION WHEN
 *                                              duplicate_object THEN NULL; END $$;
 *     (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; the DO block is the standard guard.)
 *
 * WHY EVERY NON-PK COLUMN ALSO GETS ITS OWN `ADD COLUMN IF NOT EXISTS`, immediately after that
 * table's CREATE TABLE. This is the part a plain empty->target diff cannot give you, and it is
 * the exact failure PB-16 verification (b) caught: a table that ALREADY EXISTS (created months
 * ago, before a column was added to the Drizzle model) makes `CREATE TABLE IF NOT EXISTS` a
 * total no-op — the new column never arrives, and the next statement in the same file (an index
 * or FK naming that column) then fails outright on a database that is not empty. Emitting one
 * `ADD COLUMN IF NOT EXISTS` per column, right after the table's CREATE, means an old table
 * converges to the current shape the same way a brand-new one does. A column that is `NOT NULL`
 * WITH a default backfills safely (Postgres 11+ does this without a table rewrite); a column
 * that is `NOT NULL` with NO default is added NULLABLE instead — enforcing NOT NULL on a column
 * arriving into a table that may already hold rows needs a real backfill decision this generator
 * cannot make, and refusing to guess here (rather than emitting DDL that can fail on production
 * data) is the same posture ops/aws/provision.sh takes for "creating: ..." it cannot really do.
 *
 * Usage: node --import @swc-node/register/esm-register scripts/gen-schema-migrations.mjs
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UUIDV7_SQL } from '@core/data-kernel';
import { SCHEMA_GROUPS, loadGroup } from './db-schema-groups.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'migrations');

const require = createRequire(import.meta.url);
const { generateDrizzleJson, generateMigration } = require('drizzle-kit/api');

const EMPTY_SNAPSHOT = generateDrizzleJson({});

/** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for every non-PK column of one table, from the
 * Drizzle JSON model (not the generated SQL text) — the model is what has typed default/notNull
 * fields to decide this safely. Relaxed columns (NOT NULL, no default) are flagged inline. */
function addColumnStatements(schema, tableName, table) {
  const out = [];
  for (const col of Object.values(table.columns)) {
    if (col.primaryKey) continue; // always present from CREATE TABLE; never added later here.
    const hasDefault = Object.prototype.hasOwnProperty.call(col, 'default');
    let stmt = `ALTER TABLE "${schema}"."${tableName}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`;
    if (hasDefault) {
      stmt += ` DEFAULT ${col.default}`;
      if (col.notNull) stmt += ' NOT NULL';
      stmt += ';';
    } else if (col.notNull) {
      stmt += ';  -- relaxed from NOT NULL: no default to backfill existing rows with safely';
    } else {
      stmt += ';';
    }
    out.push(stmt);
  }
  return out;
}

/** Turn one generateMigration() statement into its idempotent equivalent (CREATE SCHEMA /
 * CREATE UNIQUE INDEX / CREATE INDEX / ADD CONSTRAINT). CREATE TABLE is handled by the caller,
 * which also splices in this table's ADD COLUMN statements right after it. */
function makeIdempotent(stmt) {
  const trimmed = stmt.trim();

  if (/^CREATE SCHEMA\b/i.test(trimmed)) {
    return stmt.replace(/^CREATE SCHEMA\s+/i, 'CREATE SCHEMA IF NOT EXISTS ');
  }
  if (/^CREATE UNIQUE INDEX\b/i.test(trimmed)) {
    return stmt.replace(/^CREATE UNIQUE INDEX\s+/i, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
  }
  if (/^CREATE INDEX\b/i.test(trimmed)) {
    return stmt.replace(/^CREATE INDEX\s+/i, 'CREATE INDEX IF NOT EXISTS ');
  }
  if (/^ALTER TABLE\b.*ADD CONSTRAINT\b/i.test(trimmed)) {
    const oneLine = trimmed.replace(/\s+/g, ' ');
    return `DO $$ BEGIN\n  ${oneLine}\nEXCEPTION\n  WHEN duplicate_object THEN NULL;\nEND $$;\n`;
  }
  // Nothing else appears in this codebase's generateMigration output today (checked against
  // every one of the 13 schema groups when this file was written). Fail loud rather than
  // silently emit a non-idempotent statement a re-run would break on.
  throw new Error(
    `gen-schema-migrations: no idempotency rule for statement, refusing to guess:\n${stmt}`,
  );
}

function header(target, schema) {
  return (
    `-- GENERATED by scripts/gen-schema-migrations.mjs from the Drizzle table definitions\n` +
    `-- in ${SCHEMA_GROUPS.find((g) => g.schema === schema).packages.join(', ')}.\n` +
    `-- Do not hand-edit: change the Drizzle schema and re-run the generator.\n` +
    `-- @target: ${target}\n\n`
  );
}

async function main() {
  // The prerequisites every connection needs before any table DDL runs (mirrors
  // scripts/db-push.ts's ensurePrereqs, made idempotent the same way CREATE EXTENSION already
  // is). Written as its own migration, applied to BOTH targets: `formula` falls back to
  // DATABASE_URL when FORMULA_DATABASE_URL is unset (db-migrate.ts TARGET_ENV), so a
  // single-connection deployment just re-applies the same idempotent DDL twice.
  const prereqs = ['CREATE EXTENSION IF NOT EXISTS pg_trgm;', 'CREATE EXTENSION IF NOT EXISTS postgis;', `${UUIDV7_SQL};`].join(
    '\n\n',
  );
  writeFileSync(
    join(OUT_DIR, '0000_prerequisites.sql'),
    `-- GENERATED by scripts/gen-schema-migrations.mjs.\n` +
      `-- Extensions + the uuidv7() default function every schema group's tables need to exist\n` +
      `-- BEFORE any CREATE TABLE runs. Applied on both connections db:migrate knows about.\n\n` +
      `-- @target: main\n\n${prereqs}\n\n` +
      `-- @target: formula\n\n${prereqs}\n`,
  );
  console.log('wrote 0000_prerequisites.sql');

  let n = 1;
  for (const g of SCHEMA_GROUPS) {
    const imports = await loadGroup(g.packages);
    const target = generateDrizzleJson(imports, undefined, [g.schema], 'snake_case');
    const raw = await generateMigration(EMPTY_SNAPSHOT, target);

    const lines = [];
    let tableCount = 0;
    let addColumnCount = 0;
    for (const stmt of raw) {
      const tableMatch = /^CREATE TABLE "([^"]+)"\."([^"]+)"/.exec(stmt.trim());
      if (tableMatch) {
        const [, schema, tableName] = tableMatch;
        lines.push(stmt.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS '));
        const key = Object.keys(target.tables).find(
          (k) => target.tables[k].schema === schema && target.tables[k].name === tableName,
        );
        const adds = addColumnStatements(schema, tableName, target.tables[key]);
        lines.push(...adds);
        tableCount++;
        addColumnCount += adds.length;
        continue;
      }
      lines.push(makeIdempotent(stmt));
    }

    const targetName = g.vault ? 'formula' : 'main';
    const fname = `${String(n).padStart(4, '0')}_${g.schema}.sql`;
    writeFileSync(join(OUT_DIR, fname), header(targetName, g.schema) + lines.join('\n') + '\n');
    console.log(
      `wrote ${fname} (${raw.length} generated statements, ${tableCount} tables, ${addColumnCount} ADD COLUMN guards, @target: ${targetName})`,
    );
    n++;
  }
  console.log(`\n${n} files written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
