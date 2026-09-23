/**
 * PB-16 — the canonical schema provisioner. Applies scripts/migrations/*.sql, ordered by
 * filename, each file split into per-connection blocks by "-- @target: <name>" marker comments
 * (mirrors scripts/db-push.ts's schema routing: `formula` -> the vault's own
 * FORMULA_DATABASE_URL connection, everything else -> DATABASE_URL). Run:
 *   DATABASE_URL=postgres://... [FORMULA_DATABASE_URL=...] pnpm db:migrate
 *
 * ON AN EMPTY DATABASE THIS PRODUCES THE FULL CURRENT SCHEMA — every statement in every
 * migration file is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / a guarded DO block),
 * ordered so a table exists before anything FK-references it, and 0001-0013 are regenerated
 * from the same Drizzle definitions scripts/db-push.ts reads (scripts/gen-schema-migrations.mjs).
 * This is what makes `pnpm db:migrate` a complete replacement for "db:push once, then remember
 * which create-*.cjs scripts to also run": every table any of those scripts used to add now has
 * an ordered .sql file here, and this runner is the ONLY thing production ever executes (see
 * ops/systemd/rawprod-migrate.service and infra/aws/deploy.sh).
 *
 * `schema_migrations` LEDGER (PB-16 acceptance: "an ordered, idempotent SQL migrations with a
 * schema_migrations table"). Each connection this runner touches gets its own
 * `public.schema_migrations(id text primary key, applied_at timestamptz)` — one row per
 * (file, block-index, target) already applied on THAT connection. It is belt-and-braces, not
 * the safety net: every statement here is independently idempotent, so a database with no
 * ledger at all (or one wiped by hand) still converges correctly on the next run. What the
 * ledger buys is a) a real audit trail of when each migration first landed on a given database,
 * matching the shape of every other migration tool this repository's operators have used
 * elsewhere, and b) skipping re-execution of a block already recorded, which matters once a
 * migration file's statement count is in the hundreds (0001_iam.sql alone is 124 statements) —
 * re-parsing and re-sending all of them every deploy is wasted round trips against production.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres, { type Sql } from 'postgres';

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

/** One `postgres` client per resolved URL, opened lazily and reused across every block that
 * targets it (rather than one connection per block) — 19 migration files each split into a
 * handful of blocks would otherwise open dozens of short-lived connections for no reason. */
const clients = new Map<string, Sql>();
function clientFor(url: string): Sql {
  let c = clients.get(url);
  if (!c) {
    c = postgres(url, { max: 1, prepare: false });
    clients.set(url, c);
  }
  return c;
}

async function ensureLedger(sql: Sql): Promise<void> {
  await sql.unsafe(
    `create table if not exists public.schema_migrations (
       id text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
}

async function alreadyApplied(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`select id from public.schema_migrations where id = ${id}`;
  return rows.length > 0;
}

/** Comma-separated target names this run must NOT touch at all — not even a connection attempt.
 * Exists for exactly one deployment shape: the Vault EC2's own Postgres has no network path to
 * `main` (MIGRATION_AWS_PLAN.md §2 — vault-db's security group accepts 5432 from the vault-app
 * SG only), so `rawprod-migrate.service` runs with `SKIP_TARGETS=formula` (it cannot reach
 * vault-pg to even try) and `vault-migrate.service` runs with `SKIP_TARGETS=main` (it cannot
 * reach the shared alembic-pg instance's `rawprod` database either). Without this, `formula`'s
 * fallback-to-DATABASE_URL (below) would otherwise create the formula schema's tables on
 * whichever database each side CAN reach — silently defeating the isolation the two separate
 * RDS instances exist to provide. */
const SKIP_TARGETS = new Set(
  (process.env.SKIP_TARGETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

async function applyBlock(file: string, blockIndex: number, target: string, rawSql: string): Promise<'applied' | 'skipped' | 'skipped-by-config' | 'empty'> {
  if (SKIP_TARGETS.has(target)) return 'skipped-by-config';

  const envVar = TARGET_ENV[target];
  if (!envVar) throw new Error(`unknown migration @target "${target}" — add it to TARGET_ENV in scripts/db-migrate.ts`);
  // formula falls back to DATABASE_URL exactly like db-push.ts, since a dev/single-connection
  // setup may not have a separate FORMULA_DATABASE_URL. A deployment that must NOT fall back
  // (main and formula are unreachable from each other) sets SKIP_TARGETS instead, above.
  const url = process.env[envVar] ?? (target === 'formula' ? process.env.DATABASE_URL : undefined);
  if (!url) throw new Error(`${envVar} (or DATABASE_URL) is required to apply the "${target}" block — or add "${target}" to SKIP_TARGETS if this connection is never meant to see it`);

  // Postgres parses `--` line comments natively wherever they appear, so nothing needs to be
  // stripped before sending a block to the server. The one thing checked here is whether a
  // block is USELESS — comments and blank lines only, e.g. a file with a "-- @target: x" marker
  // and no SQL under it — which is decided against a stripped COPY, never the text executed
  // (stripping-then-executing used to also delete `--` comment lines living INSIDE a statement,
  // such as the explanatory line inside UUIDV7_SQL's function body: harmless to the schema
  // pg_dump produces, since Postgres does not persist a function body's comments, but it made
  // `db:migrate`'s output byte-diverge from `db:push`'s for no reason a schema comparison should
  // ever have to explain away).
  const withoutComments = rawSql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .trim();
  if (!withoutComments) return 'empty';
  const statements = rawSql.trim();

  const sql = clientFor(url);
  await ensureLedger(sql);
  const id = `${file}#${blockIndex}#${target}`;
  if (await alreadyApplied(sql, id)) return 'skipped';

  // Statement execution + ledger row in one transaction: a block is either fully applied AND
  // recorded, or neither — never recorded-but-not-applied (which would make a re-run skip real
  // work) or applied-but-unrecorded (harmless here only because every statement is ALSO
  // independently idempotent; still not a state to leave lying around on purpose).
  await sql.begin(async (tx) => {
    await tx.unsafe(statements);
    await tx`insert into public.schema_migrations (id) values (${id})`;
  });
  return 'applied';
}

export async function runMigrations(): Promise<void> {
  // DATABASE_URL is required UNLESS every target that would ever fall back to it is either
  // skipped or has its own URL set. The vault-only shape (SKIP_TARGETS=main,
  // FORMULA_DATABASE_URL set) is exactly this: `main` is skipped outright, and `formula`
  // resolves from FORMULA_DATABASE_URL without ever consulting DATABASE_URL.
  const mainNeedsIt = !SKIP_TARGETS.has('main');
  const formulaNeedsIt = !SKIP_TARGETS.has('formula') && !process.env.FORMULA_DATABASE_URL;
  if (!process.env.DATABASE_URL && (mainNeedsIt || formulaNeedsIt)) {
    throw new Error('DATABASE_URL is required to run migrations (unless SKIP_TARGETS and/or FORMULA_DATABASE_URL make every @target resolvable without it)');
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log('db:migrate: no migration files found');
    return;
  }

  try {
    for (const file of files) {
      // eslint-disable-next-line no-console
      console.log(`== ${file} ==`);
      const text = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const blocks = splitByTarget(text);
      for (const [i, block] of blocks.entries()) {
        const result = await applyBlock(file, i, block.target, block.sql);
        // eslint-disable-next-line no-console
        console.log(`  -> @target: ${block.target} (${result})`);
      }
    }
  } finally {
    for (const c of clients.values()) await c.end({ timeout: 5 });
  }
  // eslint-disable-next-line no-console
  console.log('== db:migrate complete ==');
}

// Only run when executed directly (`tsx scripts/db-migrate.ts` / `pnpm db:migrate`) — this
// file also exports `splitByTarget` for a pure-function regression test
// (backend/api/src/__tests__/db-migrate-split.test.ts), which must be able to import it
// without triggering a real migration run (or failing on a missing DATABASE_URL).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
