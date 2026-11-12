/**
 * SHIP-RP: "the tests the change touches" is a rule, not a judgement made at the keyboard.
 *
 * infra/aws/ship.sh deploys after the tests a change touches, not after the whole suite. Which tests
 * those are is decided by scripts/touched-tests.mjs from `git diff`, so the same commit always gets the
 * same answer and a reviewer can read the rule. One case here per row of the rule (the table is in
 * infra/aws/DEPLOY_AWS.md section 7a), plus the two ways the rule could be quietly emptied: an always-on
 * line with no reason, and a change that deletes an always-on test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error plain ESM, no types
import { selectTests, parseAlwaysList, globToRegExp, indexTest, buildIndex } from '../../../../scripts/touched-tests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ALWAYS_FILE = join(ROOT, 'infra/aws/fast-proof-always.txt');

type Selection = { files: string[]; fullSuite: boolean; migrations: boolean; notes: string[]; refusals: string[]; reasons: Record<string, string[]> };

const PKGS = new Map([
  ['backend/api', '@core/api'],
  ['backend/cluster-production', '@ra/cluster-production'],
  ['backend/backend-kernel', '@core/backend-kernel'],
  ['packages/contracts', '@core/contracts'],
]);

/** A small tree: five tests, written the way the real ones are. */
const index = new Map([
  indexTest('backend/api/src/__tests__/favicon.test.ts',
    "const DIRS = ['web', 'web-platform'];\nconst FAMILY = [{ name: 'favicon-16.png' }];\ntext('web/pair.html');"),
  indexTest('backend/api/src/__tests__/scale.test.ts',
    "import { ScaleService } from '../floor-ops/scale.service.js';"),
  indexTest('backend/api/src/__tests__/batch.test.ts',
    "import { BatchService } from '../../../cluster-production/src/index.js';"),
  indexTest('backend/api/src/__tests__/contracts.test.ts',
    "import { z } from '@core/contracts';"),
  indexTest('backend/api/src/__tests__/host-lock.test.ts',
    "const SCRIPT = join(ROOT, 'infra/aws/deploy.sh');"),
  indexTest('backend/api/src/__tests__/session-cookie.test.ts', '// always-on'),
]) as Map<string, unknown>;

const always = parseAlwaysList([
  '# comment',
  'test backend/api/src/__tests__/session-cookie.test.ts  # the session cookie is the sign-in',
  'sensitive scripts/migrations/**  # a migration',
  'sensitive backend/api/src/bridge/**  # the bridge with Alembic',
].join('\n'));

const pick = (changed: string[], extra: Partial<{ deleted: string[]; extra: string[] }> = {}): Selection =>
  selectTests({ changed, index, always, packages: PKGS, ...extra });

const ALWAYS_ON = 'backend/api/src/__tests__/session-cookie.test.ts';

test('nothing changed, or only documents: the always-on list and nothing else', () => {
  for (const changed of [[], ['docs/x.md'], ['infra/aws/DEPLOY_AWS.md'], ['README.md']]) {
    const s = pick(changed);
    assert.deepEqual(s.files, [ALWAYS_ON]);
    assert.equal(s.fullSuite, false);
    assert.equal(s.migrations, false);
  }
});

test('a changed test file runs', () => {
  const s = pick(['backend/api/src/__tests__/scale.test.ts']);
  assert.ok(s.files.includes('backend/api/src/__tests__/scale.test.ts'));
  assert.match(s.reasons['backend/api/src/__tests__/scale.test.ts']!.join(), /changed/);
});

test('a changed API source runs every test that imports it directly', () => {
  const s = pick(['backend/api/src/floor-ops/scale.service.ts']);
  assert.deepEqual(s.files, [ALWAYS_ON, 'backend/api/src/__tests__/scale.test.ts'].sort());
});

test('a changed API source with no importing test is written down, not passed over', () => {
  const s = pick(['backend/api/src/floor-ops/unknown.service.ts']);
  assert.deepEqual(s.files, [ALWAYS_ON]);
  assert.ok(s.notes.some((n) => /backend\/api\/src\/floor-ops\/unknown\.service\.ts has no direct test/.test(n)), s.notes.join('\n'));
});

test('a changed cluster source runs the tests that import that cluster, by path or by name', () => {
  const s = pick(['backend/cluster-production/src/batch.service.ts']);
  assert.ok(s.files.includes('backend/api/src/__tests__/batch.test.ts'));
  const c = pick(['packages/contracts/src/bridge.ts']);
  assert.ok(c.files.includes('backend/api/src/__tests__/contracts.test.ts'));
});

test('a changed console file runs the tests that name it: by path, or by file name', () => {
  const byPath = pick(['web/pair.html']);
  assert.ok(byPath.files.includes('backend/api/src/__tests__/favicon.test.ts'));
  const byName = pick(['web-vault/favicon-16.png']);
  assert.ok(byName.files.includes('backend/api/src/__tests__/favicon.test.ts'));
  const infra = pick(['infra/aws/deploy.sh']);
  assert.ok(infra.files.includes('backend/api/src/__tests__/host-lock.test.ts'));
});

test('a file name inside a longer one is not a match', () => {
  // `xfavicon-16.png` and `favicon-16.png.bak` are other files.
  const s = pick(['web/con-16.png']);
  assert.equal(s.files.includes('backend/api/src/__tests__/favicon.test.ts'), false);
  assert.ok(s.notes.some((n) => /web\/con-16\.png: no test names it/.test(n)));
});

test('a migration means the whole suite and the migration rehearsal', () => {
  const s = pick(['scripts/migrations/2026-11-12-x.sql']);
  assert.equal(s.fullSuite, true);
  assert.equal(s.migrations, true);
  assert.ok(s.notes.some((n) => /full suite: scripts\/migrations\/2026-11-12-x\.sql .*a migration/.test(n)));
});

test('the migration rehearsal runs because the schema changed, not because a test did', () => {
  for (const p of ['scripts/db-migrate.ts', 'scripts/db-seed.ts', 'packages/data-inventory/src/schema.ts', 'scripts/migrations/rollback/x.sql']) {
    assert.equal(pick([p]).migrations, true, p);
  }
  assert.equal(pick(['backend/api/src/__tests__/scale.test.ts']).migrations, false);
  assert.equal(pick(['web/index.html']).migrations, false);
});

test('a sensitive path means the whole suite', () => {
  const s = pick(['backend/api/src/bridge/importer.service.ts']);
  assert.equal(s.fullSuite, true);
  assert.equal(pick(['backend/api/src/floor-ops/scale.service.ts']).fullSuite, false);
});

test('e2e specs are not run, and the selection says so', () => {
  const s = pick(['e2e/specs/a.spec.ts']);
  assert.deepEqual(s.files, [ALWAYS_ON]);
  assert.ok(s.notes.some((n) => /not run/.test(n)));
});

test('--tests adds files by hand, and a glob that matches nothing is said', () => {
  const s = pick([], { extra: ['backend/api/src/__tests__/ba*.test.ts', 'backend/nope/*.test.ts'] });
  assert.ok(s.files.includes('backend/api/src/__tests__/batch.test.ts'));
  assert.ok(s.notes.some((n) => /backend\/nope\/\*\.test\.ts matched no test/.test(n)));
});

test('a change that deletes an always-on test is refused', () => {
  const s = pick([], { deleted: [ALWAYS_ON] });
  assert.equal(s.refusals.length, 1);
  assert.match(s.refusals[0]!, /deletes the always-on test backend\/api\/src\/__tests__\/session-cookie\.test\.ts/);
});

test('an always-on test this commit does not have yet is a note, not a silent skip', () => {
  const older = new Map(index);
  older.delete(ALWAYS_ON);
  const s: Selection = selectTests({ changed: [], index: older, always, packages: PKGS });
  assert.deepEqual(s.files, []);
  assert.ok(s.notes.some((n) => /always-on test .*session-cookie\.test\.ts is not in this commit/.test(n)));
});

test('an always-on or sensitive line with no reason is refused when the list is read', () => {
  assert.throws(() => parseAlwaysList('test backend/x.test.ts'), /no reason/);
  assert.throws(() => parseAlwaysList('sensitive scripts/**  #   '), /no reason/);
  assert.throws(() => parseAlwaysList('run backend/x.test.ts  # why'), /neither "test" nor "sensitive"/);
});

test('globs: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('scripts/migrations/**').test('scripts/migrations/rollback/x.sql'));
  assert.ok(globToRegExp('scripts/db-*.ts').test('scripts/db-migrate.ts'));
  assert.equal(globToRegExp('scripts/db-*.ts').test('scripts/db-x/y.ts'), false);
  assert.ok(globToRegExp('packages/data-*/**').test('packages/data-inventory/src/a.ts'));
  assert.equal(globToRegExp('packages/data-*/**').test('packages/contracts/src/a.ts'), false);
});

// ── the list that ships ─────────────────────────────────────────────────────────────────────────

test('every always-on test in the shipped list exists, and every line says why', () => {
  const list = parseAlwaysList(readFileSync(ALWAYS_FILE, 'utf8'));
  assert.ok(list.tests.length >= 10, 'the contract tests are listed');
  for (const t of list.tests) {
    assert.ok(existsSync(join(ROOT, t.path)), `${t.path} is listed and does not exist`);
    assert.ok(t.reason.length > 8, `${t.path} has no real reason`);
  }
  for (const want of ['shell-fluke.test.ts', 'session-cookie.test.ts', 'infra-ops-green.test.ts', 'infra-live-capture.test.ts',
    'aria-bridge.test.ts', 'host-lock.test.ts', 'ship-rp.test.ts', 'touched-tests.test.ts']) {
    assert.ok(list.tests.some((t: { path: string }) => t.path.endsWith(`/${want}`)), `${want} is always on`);
  }
});

test('the shipped sensitive list covers money, auth and stock as well: the three LD-7 names, not only the schema', () => {
  // LD-7: "the whole API suite still runs when a change touches money, auth, stock, a migration or the
  // bridge". The first list named stock as one cluster and money not at all.
  const list = parseAlwaysList(readFileSync(ALWAYS_FILE, 'utf8'));
  const hit = (p: string) => list.sensitive.some((s: { re: RegExp }) => s.re.test(p));
  for (const p of [
    'backend/cluster-procurement/src/vendor/vendor-price.service.ts',
    'backend/cluster-sales/src/orders/order.service.ts',
    'backend/cluster-production/src/picking/pick.service.ts',
    'backend/api/src/fg-stock/fg-stock.service.ts',
    'backend/api/src/consumption/consumption.service.ts',
    'backend/api/src/produce/produce-sweep.service.ts',
    'backend/api/src/inventory-view/stock-position.ts',
    'backend/api/src/floor/lot-split.service.ts',
    'backend/api/src/policy/policy-engine.ts',
    'backend/api/src/masking/mask.ts',
  ]) assert.ok(hit(p), `${p} must mean the whole suite`);
});

test('the shipped sensitive list covers migrations, the schema, the bridge, sign-in, stock and the vault', () => {
  const list = parseAlwaysList(readFileSync(ALWAYS_FILE, 'utf8'));
  const hit = (p: string) => list.sensitive.some((s: { re: RegExp }) => s.re.test(p));
  for (const p of [
    'scripts/migrations/2026-11-12-legacy-qc-release.sql',
    'scripts/db-migrate.ts',
    'packages/data-inventory/src/schema.ts',
    'backend/api/src/bridge/importer.service.ts',
    'backend/api/src/vault-bridge/x.ts',
    'backend/backend-kernel/src/edge/jwt-auth.guard.ts',
    'backend/cluster-inventory/src/stock.service.ts',
    'backend/cluster-formula/src/vault.service.ts',
    'scripts/ra-roles.ts',
    'backend/test-support/db.ts',
    'backend/api/src/main.ts',
  ]) assert.ok(hit(p), `${p} must mean the whole suite`);
  for (const p of ['web/index.html', 'backend/api/src/tutorial/tutorial.service.ts', 'docs/x.md']) {
    assert.equal(hit(p), false, `${p} must not`);
  }
});

test('the index reads the real tree: the favicon tests are the ones a favicon change selects', () => {
  const { index: real, packages } = buildIndex(ROOT);
  const list = parseAlwaysList(readFileSync(ALWAYS_FILE, 'utf8'));
  const s: Selection = selectTests({ changed: ['web/favicon-16.png', 'web/pair.html'], index: real, always: list, packages });
  assert.ok(s.files.includes('backend/api/src/__tests__/favicon-fluke.test.ts'));
  assert.equal(s.fullSuite, false);
  assert.equal(s.migrations, false);
});

test('the CLI prints the selection as JSON for two commits', () => {
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts/touched-tests.mjs'), '--repo', ROOT, '--base', head, '--head', head,
    '--always', ALWAYS_FILE], { encoding: 'utf8' });
  const s = JSON.parse(out) as Selection;
  assert.equal(s.fullSuite, false);
  assert.ok(s.files.length >= 10);
  assert.deepEqual(s.refusals, []);
});

test('the CLI gives the same paths for a relative --repo', () => {
  // `--repo .` once cut the first letter off every path ("ackend/api/..."), so no always-on test matched
  // and all 24 were reported as "not in this commit".
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const out = execFileSync(process.execPath, ['scripts/touched-tests.mjs', '--repo', '.', '--base', head, '--head', head,
    '--always', 'infra/aws/fast-proof-always.txt'], { encoding: 'utf8', cwd: ROOT });
  const s = JSON.parse(out) as Selection;
  assert.ok(s.files.every((f) => f.startsWith('backend/')), s.files.join('\n'));
  assert.equal(s.notes.some((n) => /is not in this commit/.test(n)), false, s.notes.join('\n'));
});
