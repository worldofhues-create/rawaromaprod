/**
 * The Factory Documents print layout (web/doc-format.js, CRM point 32). The rules that matter: a
 * record holds no certificate values, so none may appear; "certified" is never written; the address
 * comes only from the company record. Static, like console-routes.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: any = {};
vm.createContext(ctx);
vm.runInContext(read('web/doc-format.js'), ctx);
const F = ctx.RaDocFormat;
const NOF = 'Not on file';
const row = (documentType: string, extra = {}) => ({ title: 'Aventus', documentType, entityType: 'vendor', version: 1, issueDate: '2026-10-30', expiryDate: '2026-11-30', status: 'ACTIVE', ...extra });

test('both IFRA types print as a statement of conformity, never as certified', () => {
  for (const t of ['IFRA Certificate', 'IFRA Conformity Certificate']) {
    const h = F.render(row(t), null);
    assert.match(h, /IFRA Statement of Conformity/);
    assert.doesNotMatch(h, /certifi/i, t);
  }
});

test('no limits table or compliance wording without held data', () => {
  const h = F.render(row('IFRA Certificate'), null);
  assert.match(h, /Category limits<\/td><td class="v">Not on file/);
  assert.match(h, /Statement of conformity<\/td><td class="v">Not on file/);
  const text = h.replace(/<style>[\s\S]*?<\/style>/, ''); // the stylesheet has its own percentages
  assert.doesNotMatch(text, /Category 4|\d%|in compliance|valid without signature/i);
});

test('each house layout prints its absent fields as Not on file, and asserts no hazard status', () => {
  const coa = F.render(row('COA'), null);
  assert.match(coa, /CERTIFICATE OF ANALYSIS/);
  for (const l of ['Batch No', 'Best before', 'Production date']) assert.ok(coa.includes(`${l}</td><td class="v">${NOF}`), l);
  assert.ok(F.render(row('Allergen Declaration'), null).includes(`Allergen concentrations</td><td class="v">${NOF}`));
  const m = F.render(row('MSDS'), null);
  assert.ok(m.includes(`CAS No.</td><td class="v">${NOF}`));
  assert.doesNotMatch(m, /not a hazardous/i);
});

test('held record values print; an empty one says Not on file; the internal id does not print', () => {
  const h = F.render(row('COA', { referenceNo: 'R-1', documentRegistryId: '01A18B5A-x', notes: '' }), null);
  assert.ok(h.includes('Reference no.</td><td class="v">R-1'));
  assert.ok(h.includes(`Notes</td><td class="v">${NOF}`));
  assert.doesNotMatch(h, /01A18B5A/);
});

test('other document types keep the plain record under the letterhead', () => {
  const h = F.render(row('Contract'), null);
  assert.match(h, /DOCUMENT RECORD/);
  assert.ok(h.includes('Document type</td><td class="v">Contract'));
});

test('letterhead carries the decided phone; the address comes only from one active company', () => {
  assert.match(F.render(row('COA'), null), /\+91 86299 12883/);
  const noAddr = F.render(row('COA'), null);
  assert.doesNotMatch(noAddr, /Shri Nagar|4520|99810/);
  assert.equal(F.companyAddress([]), null);
  assert.equal(F.companyAddress([{ type: 'COMPANY', status: 'ACTIVE', name: 'x' }]), null);
  assert.equal(F.companyAddress([{ type: 'GROUP', address: 'A' }]), null);
  assert.equal(F.companyAddress([{ type: 'COMPANY', address: 'A' }, { type: 'COMPANY', address: 'B' }]), null);
  assert.equal(F.companyAddress([{ type: 'COMPANY', status: 'ACTIVE', address: 'A', pincode: '1' }]), 'A, 1');
  assert.match(F.render(row('COA'), 'A, 1'), /<div>A, 1<\/div>/);
});

test('record text is escaped: a title cannot inject markup into the print window', () => {
  const h = F.render(row('COA', { title: '<img src=x onerror=1>' }), null);
  assert.doesNotMatch(h, /<img/);
});

test('the Factory loads and caches doc-format.js, and printDoc uses it for Documents only', () => {
  assert.match(read('web/index.html'), /doc-format\.js"><\/script>\s*<script src="\/shell\.js"/);
  assert.match(read('web/sw.js'), /'\/doc-format\.js'/);
  assert.match(read('web/shell.js'), /endpoint === '\/v1\/document-registry'[\s\S]{0,300}RaDocFormat\.render/);
});
