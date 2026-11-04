/**
 * WALK-RP-2: the Factory and Platform service workers serve the shell cache-first, so an installed
 * console keeps running the cached shell.js until the cache name changes. Factory's cache stayed at
 * ra-shell-v105 through SWEEP2-O6, SWEEP2-O7 and SWEEP2-R1 (one write per press, plain status words,
 * the idempotency key on every write), so an installed console kept double-writing on a double press.
 * Rule held here: the last commit that touched any precached file is an ancestor of (or is) the last
 * commit that touched that console's sw.js. Checked on commits, which is what ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

for (const dir of ['web', 'web-platform']) {
  test(`${dir}/sw.js cache name moves with every precached file it serves`, (t) => {
    try { git('rev-parse', 'HEAD'); } catch { t.skip('not a git checkout: cannot check the cache bump'); return; }
    const sw = strip(readFileSync(join(root, dir, 'sw.js'), 'utf8'));
    const list = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
    const files = [...list.matchAll(/'\/([^']+\.(?:js|css|html))'/g)].map((m) => `${dir}/${m[1]}`);
    files.push(`${dir}/index.html`);
    const swCommit = git('rev-list', '-1', 'HEAD', '--', `${dir}/sw.js`);
    const late: string[] = [];
    for (const f of new Set(files)) {
      const c = git('rev-list', '-1', 'HEAD', '--', f);
      if (!c) continue;
      try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', c, swCommit]); }
      catch { late.push(`${f} (${git('log', '-1', '--format=%s', c).slice(0, 40)})`); }
    }
    assert.deepEqual(late, [], `${dir}/sw.js cache name not bumped after: ${late.join('; ')}`);
  });
}
