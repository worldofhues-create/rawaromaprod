/**
 * FACTORY-SETUP (lane catalogue) — the Factory console carries the setup screen (static checks, no
 * browser; the screen itself is driven in a headless browser against a real API for this lane):
 * ws-setup.js loads after ws-produce.js and is cached offline, registers its view for the roles
 * that set the factory up, calls only through the encrypted tunnel, and shows no developer text —
 * no table, schema, file or ticket name reaches a screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** The script with comments removed: what can reach a screen is in code, not in its commentary. */
function code(js: string): string {
  return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

test('Factory: ws-setup.js loads after ws-produce.js, before the tutorial, and is cached offline', () => {
  const html = read('web/index.html');
  const at = (s: string) => html.indexOf(`<script src="/${s}"></script>`);
  assert.ok(at('ws-setup.js') > at('ws-produce.js') && at('ws-produce.js') > 0);
  assert.ok(at('ws-setup.js') < at('tutorial.js'));
  const sw = read('web/sw.js');
  assert.match(sw, /'\/ws-setup\.js'/);
  assert.match(sw, /const CACHE = 'ra-shell-v102'/);
});

test('Factory setup: registered for owner, QC, warehouse and production; tunnel only; the bin-label printer is shared', () => {
  const js = read('web/ws-setup.js');
  assert.match(js, /registerViews\(\{ __factorysetup__: viewSetup \}\)/);
  assert.match(js, /\['superadmin', 'qc', 'warehouse', 'production'\]/);
  assert.ok(!/\bfetch\(/.test(js), 'every call goes through the encrypted tunnel');
  assert.match(read('web/ws-produce.js'), /window\.RA\.printBinLabels = printBinLabels;/);
  for (const path of ['/v1/factory-setup/checklist', '/v1/factory-setup/qc-proposals/decide', "/v1/factory-setup/rack-proposals/' + p.setupProposalId + '/decide"]) {
    assert.ok(js.includes(path), path);
  }  // "Formulas linked" shows the Vault-approved count and opens the Formula setup screen (lane
  // vaultsetup) only for a role that has it and may read the links.
  assert.match(js, /fx\.linked === fx\.products && fx\.approved === fx\.products/);
  assert.match(js, /can\('packaging:product_formula_link:read'\) && !!ROLES\[st\.role\] && ROLES\[st\.role\]\.nav\.some\(function \(n\) \{ return n\[0\] === 'formulasetup'; \}\)/);
  assert.match(js, /navTo\('formulasetup'\)/);
});

test('Factory setup: the label printer needs no setup and says so, at the sizes the label screen prints', () => {
  const js = code(read('web/ws-setup.js'));
  assert.match(js, /Nothing to set up: labels print from the browser — 100×50 mm, 100×150 mm, 62 mm continuous or an A4 sheet\./);
});

test('Factory setup: no developer text on screen (no table, schema, file, ticket or lane names)', () => {
  const js = code(read('web/ws-setup.js'));
  const strings = [...js.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? '')
    // Not shown: tunnel paths, single keys, element ids and permission codes (checked, never printed).
    .filter((s) => !s.startsWith('/v1/') && !/^[a-z_]+$/.test(s) && !/^(sv-|data-)/.test(s) && !/^[a-z_]+:[a-z_]+:[a-z]+$/.test(s));
  const leaks = strings.filter((s) =>
    /\b(production|packaging|bridge|masterdata|location|iam)\.[a-z_]+\b/.test(s)       // schema.table
    || /\b[a-z]+_[a-z_]+\b/.test(s.replace(/data-[a-z]+|sv-[a-z-]+|setupProposalId/g, '')) // snake_case identifiers
    || /\.(ts|js|sql|md)\b/.test(s)                                                     // file names
    || /\b(FACTORY-SETUP|RP-[A-Z0-9]+|PB-\d+|lane\b)/.test(s));                          // ticket / lane ids
  assert.deepEqual(leaks, []);
  // Every figure shows where it came from, in plain words.
  assert.match(js, /From a document/);
  assert.match(js, /From the catalogue/);
  assert.match(js, /Ruh\\'s estimate/);
});
