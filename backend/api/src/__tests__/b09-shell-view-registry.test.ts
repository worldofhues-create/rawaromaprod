/**
 * B09 (STUB-079): the factory web shell's workspace view registry (web/shell.js `RA_VIEWS`,
 * `registerViews`) was described as "Not wired into the render path yet", and one registration
 * (web/tutorial.js, under the bare key `tutorial`) and one export (`window.RA.views`) were inert.
 *
 * The registry IS the render path for every `__name__` sentinel nav item (loadView dispatches
 * `RA_VIEWS[item[3]]` when item[3] matches /^__[a-z]+__$/), so it stays. What could never render
 * is removed, and these checks prove nothing that does render was touched:
 *   - every key any web module registers is a sentinel loadView can dispatch;
 *   - nothing reads `RA.views`;
 *   - the tutorial opens through loadView's explicit `__tutorial__` branch, as before;
 *   - the stale sentence is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const strip = (js: string) => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const dirs = ['web', 'web-platform', 'web-vault'];
const files = dirs.flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.js')).map((f) => join(root, d, f)));
const code = new Map(files.map((f) => [f, strip(readFileSync(f, 'utf8'))]));
const shell = code.get(join(root, 'web', 'shell.js'))!;

test('B09 · every view a web module registers is a sentinel loadView dispatches', () => {
  const keys: string[] = [];
  for (const [f, js] of code) {
    for (const m of js.matchAll(/registerViews\(\{([\s\S]*?)\}\)/g)) {
      for (const k of m[1]!.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*:/g)) keys.push(`${f.replace(root + '/', '')}:${k[1]}`);
    }
  }
  assert.ok(keys.length >= 10, `found ${keys.length} registrations: the scan has stopped reaching them`);
  const dead = keys.filter((k) => !/:__[a-z]+__$/.test(k));
  assert.deepEqual(dead, [], 'a key that is not a __name__ sentinel can never be rendered');
  /* the dispatch it relies on is still there */
  assert.match(shell, /\/\^__\[a-z\]\+__\$\/\.test\(item\[3\]\) && typeof RA_VIEWS\[item\[3\]\] === 'function'/);
});

test('B09 · nothing reads RA.views, and the shell no longer exports it', () => {
  for (const [f, js] of code) assert.doesNotMatch(js, /RA\.views\b/, f);
  assert.match(shell, /window\.RA = \{ tunnel: tunnel, uploadFile: uploadFile, registerViews: registerViews \};/);
});

test('B09 · the tutorial still opens through loadView, by name', () => {
  assert.match(shell, /item\[3\] === '__tutorial__'\) \{ return \(typeof loadTutorialView === 'function'\) \? loadTutorialView\(\)/);
  assert.match(shell, /\['tutorial', 'Tutorials', 'bookOpen', '__tutorial__'\]/);
  assert.doesNotMatch(code.get(join(root, 'web', 'tutorial.js'))!, /registerViews/);
});

test('B09 · the registry is no longer described as unwired', () => {
  const raw = readFileSync(join(root, 'web', 'shell.js'), 'utf8') + readFileSync(join(root, 'web', 'tutorial.js'), 'utf8');
  assert.doesNotMatch(raw, /Not wired into the render path yet|not wired into rendering yet|NOT wired into this/);
});
