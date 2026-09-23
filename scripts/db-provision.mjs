/**
 * db:provision — one idempotent command that provisions a FRESH console database from empty, in
 * the correct order. This is the reproducibility fix (audit H-R): standing up a new (e.g. offline)
 * console is now a single step instead of a hand-run sequence that silently omitted ad-hoc tables.
 *
 *   DATABASE_URL=... [FORMULA_DATABASE_URL=...] pnpm db:provision
 *
 * PB-16: schema provisioning is now `pnpm db:migrate` ALONE — scripts/migrations/0000..0013 are
 * generated from the same Drizzle definitions db:push reads (scripts/gen-schema-migrations.mjs)
 * and 0014+ are every one of this directory's create-*.cjs scripts' schema DDL, hand-ported into
 * ordered, idempotent .sql files (see scripts/db-migrate.ts's header). db:migrate is verified to
 * be a strict superset of `db:push` on an empty database, AND — unlike db:push, which is
 * create-once and skips a whole schema the moment it already has any table — to bring an
 * ALREADY-POPULATED database (created by an older Drizzle snapshot, i.e. exactly what the
 * create-*.cjs scripts existed to patch) up to the same full current schema, because every
 * statement is idempotent at the STATEMENT level (CREATE TABLE / ADD COLUMN / ADD CONSTRAINT
 * IF NOT EXISTS), not the schema-population level db:push checks. Calling `pnpm db:push` here
 * too would not be wrong (it is now fully redundant with db:migrate's first 14 files) but would
 * double every round trip for no additional effect, so it is dropped.
 *
 * The create-*.cjs scripts themselves are UNCHANGED and still safe to run by hand (all idempotent
 * CREATE/ADD IF NOT EXISTS) — db:provision just no longer needs to, except
 * create-packaging-qc-table.cjs, kept under OPTIONAL below for the 3 demo rows it seeds (its
 * schema half is now a no-op, superseded by scripts/migrations/0009_packaging.sql).
 *
 * Schema + RBAC steps are REQUIRED (abort on failure); data seeds are best-effort (a fresh
 * console must BOOT even if demo data is skipped). Re-running is safe (all steps idempotent or
 * CREATE/INSERT-IF-NOT-EXISTS).
 */
import { execSync } from 'node:child_process';

const REQUIRED = [
  ['schema: db:migrate (canonical — PB-16)', 'pnpm db:migrate'],
  ['seed: RBAC (roles + permissions)', 'pnpm db:seed'],
];
const OPTIONAL = [
  ['data: domain demo data', 'pnpm db:seed:data'],
  ['data: packaging QC demo rows', 'node scripts/create-packaging-qc-table.cjs'],
  ['data: org units', 'node scripts/seed-org.cjs'],
  ['data: screens', 'node scripts/seed-screens.cjs'],
  ['data: flow gaps', 'node scripts/seed-flow-gaps.cjs'],
  ['data: trace links', 'node scripts/seed-trace-links.cjs'],
  ['data: approval matrix (35 rows)', 'node scripts/seed-approval-matrix.cjs'],
  // Portal-audit WS6: runs LAST so the org/warehouse/user parents from the seeds above exist —
  // fills the empty country/location-type/business-unit/floor/bin masters + wires null hierarchy
  // FKs + backfills user employee_code/mobile_number.
  ['data: master hierarchy (countries/BUs/location-types/floors/bins + wiring)', 'node scripts/seed-master-hierarchy.cjs'],
  // WS8: fill uom_id on quantity rows so the UI shows units (kg/L/ml/pcs), not bare numbers.
  ['data: unit-of-measure backfill (materials + quantity rows)', 'node scripts/backfill-uom.cjs'],
];

function run(name, cmd, required) {
  console.log(`\n▶ ${name}\n  ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env });
  } catch (e) {
    if (required) { console.error(`\n✗ REQUIRED step failed: ${name} — aborting.`); process.exit(1); }
    console.warn(`  ⚠ optional step failed (${name}) — continuing.`);
  }
}

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(1); }
console.log('== db:provision — fresh console database ==');
for (const [n, c] of REQUIRED) run(n, c, true);
for (const [n, c] of OPTIONAL) run(n, c, false);
console.log('\n✓ provision complete — the console can boot.');
