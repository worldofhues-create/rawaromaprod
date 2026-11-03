/**
 * SWEEP-FACTORY: Products > Link formula (web/ws-formula-setup.js; no browser). The picker read one
 * page of 500 and swallowed a dropped connection (`.catch(function () {})`), leaving "Loading…" in
 * the dropdown and "Pick a formula." on Save. It now reads every page through shell.js's fkRows
 * and shows a failure in the dropdown and the form's error line. Runs the sheet's own loader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const js = readFileSync(join(root, 'web/ws-formula-setup.js'), 'utf8');
const body = js.slice(js.indexOf('function openLinkFormula('), js.indexOf('m.sheet.onsubmit', js.indexOf('function openLinkFormula(')));

test('the Link formula picker reads every page and never swallows a failure', () => {
  assert.doesNotMatch(body, /limit=500/);
  assert.doesNotMatch(body, /\.catch\(function \(\) \{\}\)/);
  assert.match(body, /fkRows\('\/v1\/formulas'\)/);
  assert.match(body, /fs-link-err'\)\.textContent = /);
});
