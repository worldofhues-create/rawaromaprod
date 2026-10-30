/**
 * Lane vaultsetup — the consoles carry the formula-setup screens (static checks, no browser; the
 * screens were also driven in a headless browser against the real two-process stack — see the
 * lane report). Factory: ws-formula-setup.js loads after ws-produce.js, is cached offline, renders
 * the two-owner Ruh card, the shells and the guarded link — formula CODES only, everything through
 * the encrypted tunnel. Vault: "Recipes needed" + the upload go to the Vault box (never the main
 * box), and the bulk approval goes through withFreshAuth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('Factory: ws-formula-setup.js loads after ws-produce.js (before tutorial.js) and is cached offline in the bumped shell', () => {
  const html = read('web/index.html');
  const at = (s: string) => html.indexOf(`<script src="/${s}"></script>`);
  assert.ok(at('ws-formula-setup.js') > at('ws-produce.js') && at('ws-produce.js') > 0);
  assert.ok(at('ws-formula-setup.js') < at('tutorial.js'));
  const sw = read('web/sw.js');
  assert.match(sw, /'\/ws-formula-setup\.js'/);
  assert.match(sw, /const CACHE = 'ra-shell-v100'/);
});

test('Factory: the screen — two-owner Ruh card, shells, guarded link; tunnel only; no formula name or content', () => {
  const js = read('web/ws-formula-setup.js');
  assert.ok(js.includes('__formulasetup__'));
  for (const route of [
    "'/v1/service-principals/ruh'",
    "'/v1/service-principals/ruh/formulator-request'",
    "'/v1/vault-role-grant-requests/'",
    "'/v1/formula-setup/products'",
    "'/v1/formula-setup/shells'",
    "'/v1/formulas?limit=500'",
    "'/formula-link'",
  ]) assert.ok(js.includes(route), route);
  assert.ok(!/\bfetch\(/.test(js), 'every call goes through tunnel()');
  assert.ok(!/formulaName|formula_name|percentage/.test(js), 'the factory never reads a formula name or a percentage');
  // The approval is the EXISTING two-person route — no Ruh-specific shortcut.
  assert.ok(!/ruh\/approve/.test(js));
  // The kind defaults to the catalogue's; a catalogue blend sealed as a single chemical is sent as an
  // explicit override (the server refuses it otherwise) and the confirmation says so.
  assert.match(js, /var kind = p\.catalogueKind \|\| 'blend';/);
  assert.match(js, /if \(body\.kind === 'single_chemical' && p\.catalogueKind === 'blend'\) body\.overrideCatalogue = true;/);
  assert.match(js, /blends in the ALEMBIC catalogue — you are overriding it/);
  // Products table row action, gated by the new permission.
  assert.match(js, /ACTIONS\['\/v1\/products'\]/);
  assert.match(js, /perm: 'packaging:product_formula_link:write'/);
});

test('Factory: the New product form\'s Formula dropdown reads /v1/formulas, which now exists on the main box', () => {
  const shell = read('web/shell.js');
  assert.match(shell, /\{ n: 'formulaId', l: 'Formula', t: 'select', fk: '\/v1\/formulas', fv: 'formulaId', fl: 'formulaCode' \}/);
  const ctl = read('backend/api/src/formula-setup/formula-setup.controller.ts');
  assert.match(ctl, /@Get\('v1\/formulas'\)/);
});

test('Vault: Recipes needed + upload talk to the Vault box only; the bulk approval asks for one fresh sign-in', () => {
  const js = read('web-vault/vault.js');
  assert.match(js, /\{ id: 'recipes', label: 'Recipes needed', icon: 'testtube', need: 'formula:formula_version:read' \}/);
  assert.match(js, /\{ id: 'review', label: 'Approve recipes', icon: 'clipCheck', need: 'formula:formula_approval:write' \}/);
  assert.match(js, /[^n]api\('\/v1\/formula-setup\/recipes'\)/);
  assert.match(js, /[^n]api\('\/v1\/formula-recipes\/import'/);
  assert.match(js, /[^n]api\('\/v1\/formula-review-queue'\)/);
  assert.ok(!/mainApi\('\/v1\/formula-(recipes|setup|review)/.test(js), 'recipe content never goes to the main box');
  assert.match(js, /withFreshAuth\(function \(\) \{\s*return api\('\/v1\/formula-versions\/approve-batch'/);
  // No recipe is ever logged.
  assert.ok(!/console\.log\(/.test(js));
});
