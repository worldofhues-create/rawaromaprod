/**
 * Additive migration runner (security review item 8) — applies scripts/migrations/*.sql,
 * ordered by filename, each file split into per-connection blocks by "-- @target: <name>"
 * marker comments (mirrors scripts/db-push.ts's schema routing: `formula` -> the vault's own
 * FORMULA_DATABASE_URL connection, everything else -> DATABASE_URL). Every statement in every
 * migration file MUST be idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / a guarded DO
 * block) — this runner does not track "already applied" state itself, it just re-runs
 * idempotent DDL, same posture as db-push.ts. Run:
 *   DATABASE_URL=postgres://... [FORMULA_DATABASE_URL=...] pnpm db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Target name (from "-- @target: <name>") -> which URL env var it applies to. */
const TARGET_ENV: Record<string, string> = {
  formula: 'FORMULA_DATABASE_URL',
  main: 'DATABASE_URL',
};

/** Split one migration file's text into { target, sql } blocks by its "-- @target: x" markers.
 * Everything before the first marker (pure commentary/header) is discarded. */
export function splitByTarget(text: string): Array<{ target: string; sql: string }> {
  const lines = text.split('\n');
  const blocks: Array<{ target: string; sql: string }> = [];
  let current: { target: string; sql: string[] } | null = null;
  for (const line of lines) {
    const marker = /^--\s*@target:\s*(\S+)/.exec(line);
    if (marker) {
      if (current) blocks.push({ target: current.target, sql: current.sql.join('\n') });
      current = { target: marker[1]!, sql: [] };
      continue;
    }
    if (current) current.sql.push(line);
  }
  if (current) blocks.push({ target: current.target, sql: current.sql.join('\n') });
  return blocks;
}

async function applyBlock(target: string, sql: string): Promise<void> {
  const envVar = TARGET_ENV[target];
  if (!envVar) throw new Error(`unknown migration @target "${target}" — add it to TARGET_ENV in scripts/db-migrate.ts`);
  // formula falls back to DATABASE_URL exactly like db-push.ts, since a dev/single-connection
  // setup may not have a separate FORMULA_DATABASE_URL.
  const url = process.env[envVar] ?? (target === 'formula' ? process.env.DATABASE_URL : undefined);
  if (!url) throw new Error(`${envVar} (or DATABASE_URL) is required to apply the "${target}" block`);
  const statements = sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .trim();
  if (!statements) return;

  const client = postgres(url, { max: 1, prepare: false });
  try {
    await client.unsafe(statements);
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run migrations');

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log('db:migrate: no migration files found');
    return;
  }

  for (const file of files) {
    // eslint-disable-next-line no-console
    console.log(`== ${file} ==`);
    const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const blocks = splitByTarget(text);
    for (const block of blocks) {
      // eslint-disable-next-line no-console
      console.log(`  -> @target: ${block.target}`);
      await applyBlock(block.target, block.sql);
    }
  }
  // eslint-disable-next-line no-console
  console.log('== db:migrate complete ==');
}

// Only run when executed directly (`tsx scripts/db-migrate.ts` / `pnpm db:migrate`) — this
// file also exports `splitByTarget` for a pure-function regression test
// (backend/api/src/__tests__/db-migrate-split.test.ts), which must be able to import it
// without triggering a real migration run (or failing on a missing DATABASE_URL).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
