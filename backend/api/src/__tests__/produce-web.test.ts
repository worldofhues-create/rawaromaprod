/**
 * Lane produce — the Factory / Platform / Vault consoles carry the new screens (static checks, no
 * browser): ws-produce.js loads after the other workspace modules and is in the offline shell, the
 * shell dispatches its sentinel views, the Platform console lists the bridge + pick-to-light
 * screens (and bumped its cache), and the Vault console's formula-needed read goes to the main box.
 * The screens themselves were exercised in a headless browser against a real API for this lane.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('Factory: ws-produce.js loads after the other workspace modules and is cached offline', () => {
  const html = read('web/index.html');
  const at = (s: string) => html.indexOf(`<script src="/${s}"></script>`);
  assert.ok(at('ws-produce.js') > at('ws-platform.js') && at('ws-platform.js') > at('shell.js'), 'after shell.js and ws-platform.js');
  assert.ok(at('ws-produce.js') < at('tutorial.js'));
  const sw = read('web/sw.js');
  assert.match(sw, /'\/ws-produce\.js'/);
  assert.match(sw, /const CACHE = 'ra-shell-v94'/);
});

test('Factory: the shell dispatches sentinel views to RA_VIEWS, and ws-produce registers the four screens', () => {
  assert.match(read('web/shell.js'), /RA_VIEWS\[item\[3\]\]\(item, \$\('ra-view'\)\)/);
  const js = read('web/ws-produce.js');
  for (const v of ['__produce__', '__shelftasks__', '__racklayout__', '__shelfdisplay__']) assert.ok(js.includes(v), v);
  // The floor sees formula CODE + VERSION only — no other formula field is ever read by the screen.
  assert.ok(!/formulaName|formula_name|materialName/.test(js));
  // Every mutation goes through the encrypted tunnel, never a bare fetch.
  assert.ok(!/\bfetch\(/.test(js));
});

test('Platform: the ALEMBIC bridge and pick-to-light screens, gated, and a cache bump', () => {
  const js = read('web-platform/platform.js');
  assert.match(js, /\{ id: 'bridge', label: 'ALEMBIC bridge', icon: 'link', need: 'platformops:console:read' \}/);
  assert.match(js, /\{ id: 'picklight', label: 'Pick-to-light', icon: 'bulb', need: 'platform:flag:write' \}/);
  assert.match(read('web-platform/sw.js'), /platform-shell-v14/);
});

test('Vault: the formula-needed list comes from the main box, never the Vault box', () => {
  const js = read('web-vault/vault.js');
  assert.match(js, /mainApi\('\/v1\/produce\/formula-needs'\)/);
  assert.ok(!/[^n]api\('\/v1\/produce/.test(js), 'no Vault-box call for produce data');
});
