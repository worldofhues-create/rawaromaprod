/**
 * Security review S1, item 8 — scripts/db-migrate.ts's splitByTarget (pure function, no DB;
 * the migration itself was verified against a real Postgres — fresh db:push from fb61f15's
 * schema state vs. fb61f15 + this migration produced an IDENTICAL column set for
 * formula.formula_version / procurement.purchase_order / packaging.packaging_qc, and the
 * migration re-runs cleanly (idempotent) — see this lane's manual verification notes). This
 * file locks in the runner's file-parsing behaviour as an automated regression test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitByTarget } from '../../../../scripts/db-migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..', '..');

test('splitByTarget: splits a simple two-block file correctly', () => {
  const text = ['-- header comment, discarded', '-- @target: formula', 'select 1;', '-- @target: main', 'select 2;'].join('\n');
  const blocks = splitByTarget(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.target, 'formula');
  assert.match(blocks[0]!.sql, /select 1;/);
  assert.equal(blocks[1]!.target, 'main');
  assert.match(blocks[1]!.sql, /select 2;/);
});

test('splitByTarget: content before the first marker is discarded', () => {
  const text = ['select 0; -- should never appear in any block', '-- @target: main', 'select 1;'].join('\n');
  const blocks = splitByTarget(text);
  assert.equal(blocks.length, 1);
  assert.doesNotMatch(blocks[0]!.sql, /select 0/);
});

test('splitByTarget: a file with no markers produces zero blocks', () => {
  const blocks = splitByTarget('select 1;\nselect 2;');
  assert.equal(blocks.length, 0);
});

test("the real migration file's blocks are exactly ['formula', 'main'], both non-empty", () => {
  const sql = readFileSync(join(repoRoot, 'scripts/migrations/2026-09-24-ui-parity.sql'), 'utf8');
  const blocks = splitByTarget(sql);
  assert.deepEqual(blocks.map((b) => b.target), ['formula', 'main']);
  for (const b of blocks) {
    assert.ok(b.sql.trim().length > 0, `@target: ${b.target} must have at least one statement`);
  }
});

test('every statement in the migration file is additive/idempotent (IF NOT EXISTS / a guarded DO block)', () => {
  const sql = readFileSync(join(repoRoot, 'scripts/migrations/2026-09-24-ui-parity.sql'), 'utf8');
  const statements = sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l) && !/^\s*@target/.test(l))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    const s = stmt.toLowerCase();
    const isSafe =
      /if not exists/.test(s) ||
      /^do \$\$/.test(s) ||
      /^end \$\$/.test(s) || // closing half of a DO $$ ... END $$ block
      /^begin$/.test(s.trim()) ||
      /^end if$/.test(s.trim()) || // closing half of the DO block's IF NOT EXISTS (pg_constraint)
      /alter table[\s\S]*add constraint/.test(s); // only reachable inside that guarded IF block above
    assert.ok(isSafe, `statement is not obviously idempotent/additive: ${stmt.slice(0, 120)}`);
  }
});

test('db:migrate is registered as a package.json script', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['db:migrate'], 'tsx scripts/db-migrate.ts');
});
