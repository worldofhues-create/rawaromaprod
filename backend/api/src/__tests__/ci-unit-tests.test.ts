/**
 * FLOOR-FIX-15 (Alembic doc 17 §5.8) — the unit tests run where they can fail a push. backend/api's
 * own `test` script globbed src/**\/*.spec.ts, which matches no file (all 200+ are *.test.ts), and
 * CI ran only the Playwright walks, so none of the bridge contract tests ran on a push.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

test('backend/api `test` runs its *.test.ts files', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'backend/api/package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.test!, /\*\.test\.ts/);
});

test('a CI workflow runs the unit suite against a PostGIS Postgres on every push and pull request', () => {
  const dir = join(ROOT, '.github/workflows');
  const yml = readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => readFileSync(join(dir, f), 'utf8'));
  const unit = yml.find((y) => /run: pnpm test\b/.test(y));
  assert.ok(unit, 'a workflow step runs `pnpm test` (backend/test-support/run-tests.mjs)');
  assert.match(unit!, /postgis\/postgis/);
  assert.match(unit!, /TEST_DATABASE_URL/);
  assert.match(unit!, /pull_request/);
  assert.match(unit!, /push/);
});
