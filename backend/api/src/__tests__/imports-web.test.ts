/**
 * IMPORT-RP — the import panel in the two consoles, read as files: one panel, the same copy in both;
 * the Factory mounts it on the lists that have a template and never offers formulas; the Vault mounts
 * formulas and nothing else; the panel goes through the console's own channel and keeps no file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FACTORY_IMPORT_SPECS } from '../imports/kind-specs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('one panel: the Factory and the Vault consoles carry the same copy, byte for byte', () => {
  assert.equal(read('web/import-panel.js'), read('web-vault/import-panel.js'));
});

test('the panel talks only through the console\'s own channel and keeps nothing: no fetch, no storage, no log', () => {
  const panel = code(read('web/import-panel.js')), glue = code(read('web/ws-imports.js'));
  for (const src of [panel, glue]) {
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon/);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/);
    assert.doesNotMatch(src, /console\.(log|info|warn|error|debug)/);
  }
  // Who sees it is the server's answer, not the console's own guess.
  assert.match(panel, /\/v1\/imports\/kinds/);
  assert.doesNotMatch(glue, /\bcan\(/);
  // A file larger than the channel carries is refused in a sentence before it is sent.
  assert.match(panel, /MAX_FILE_BYTES = 550 \* 1024/);
  assert.match(panel, /Split the sheet into smaller files/);
});

test('the Factory mounts a kind where its single-record screen lives, and never formulas', () => {
  const glue = read('web/ws-imports.js');
  const mounted = [...glue.matchAll(/kinds: \[([^\]]*)\]/g)].flatMap((m) => m[1]!.split(',').map((k) => k.trim().replace(/'/g, '')));
  assert.deepEqual([...mounted].sort(), FACTORY_IMPORT_SPECS.map((s) => s.kind).sort(), 'every factory kind has a screen, and nothing else is mounted');
  assert.equal(mounted.includes('formulas'), false);
  for (const endpoint of ['/v1/materials', '/v1/vendors', '/v1/grns', '/v1/rm-batches', '/v1/stock-adjustments', '/v1/packaging-boms']) {
    assert.ok(glue.includes(`'${endpoint}'`), endpoint);
    assert.ok(read('web/shell.js').includes(`'${endpoint}'`), `${endpoint} is a screen on the Factory rail`);
  }
  const shell = read('web/shell.js');
  assert.equal((shell.match(/RaImports\.mount\(item\[3\], V\)/g) ?? []).length, 2, 'the filled list and the empty list both offer it');
  const index = read('web/index.html');
  assert.ok(index.indexOf('/shell.js') < index.indexOf('/import-panel.js') && index.indexOf('/import-panel.js') < index.indexOf('/ws-imports.js'));
});

test('the Vault mounts formulas, and only formulas, on Recipes needed; a formula\'s rows to fix are read from the file sent again', () => {
  const vault = read('web-vault/vault.js');
  assert.match(vault, /RaImportPanel\.card\(\{ api: api, kinds: \['formulas'\]/);
  assert.equal((vault.match(/RaImportPanel\./g) ?? []).length, 1);
  const index = read('web-vault/index.html');
  assert.ok(index.indexOf('/import-panel.js') < index.indexOf('/vault.js'));
  assert.match(read('web/import-panel.js'), /s\.secret \? \{ format: format, fileBase64: st\.base64 \} : \{ format: format \}/);
});

test('installed consoles get the panel: the cache is v144 (one number for the whole release; the lane took v143) and precaches both files', () => {
  const sw = read('web/sw.js');
  assert.match(sw, /const CACHE = 'ra-shell-v145'/);
  for (const f of ['/import-panel.js', '/ws-imports.js']) assert.ok(sw.includes(`'${f}'`), f);
});
