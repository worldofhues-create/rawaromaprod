/**
 * SCAN-9..12 (owner: every step of both flows has a Print button, every label carries both codes, a
 * reprint needs a reason and says REPRINT, and each label scans at the next step).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const grantOf = (code: string) => RA_PERMISSIONS.filter((p) => ROLES.find((x) => x.code === code)!.select(p));
const read = (f: string) => readFileSync(new URL(`../../../../${f}`, import.meta.url), 'utf8');

test('SCAN-9: the roles that own raw-flow steps can print their labels, and gain nothing else from it', () => {
  for (const r of ['procurement', 'receiving', 'qc']) {
    assert.ok(grantOf(r).includes('platform:print_job:write'), `${r} prints`);
    assert.ok(grantOf(r).includes('platform:print_job:read'), `${r} sees its print history`);
    assert.ok(!grantOf(r).includes('platform:device:write'), `${r} does not manage devices`);
  }
});

test('SCAN-9: one Print / Reprint helper; reprint asks for a reason and goes through the print-job reprint', () => {
  const src = read('web/ws-floor-ops.js');
  assert.match(src, /window\.RA\.stepPrint = stepPrint; window\.RA\.stepReprint = stepReprint; window\.RA\.stepButtons = stepButtons;/);
  const rp = src.slice(src.indexOf('async function stepReprint('), src.indexOf('async function stepReprint(') + 1200);
  assert.match(rp, /Why reprint\?', req: true/);
  assert.match(rp, /\/reprint', 'POST', \{ reason: v\.reason \}/);
});

/** The source between `start` and the next `function ` at the same depth, roughly: enough to assert on. */
const near = (src: string, start: string, len = 4000) => { const i = src.indexOf(start); assert.ok(i >= 0, `found ${start}`); return src.slice(i, i + len); };

test('SCAN-10 raw flow: every step offers Print + Reprint with both codes', () => {
  const shell = read('web/shell.js'), fb = read('web/ws-floorb.js');
  // R1 PO, R2 gate entry, R4 GRN, R5 incoming QC, raw batches and containers: row actions on their screens
  for (const [ep, kind, code] of [['/v1/purchase-orders', 'po', 'poNumber'], ['/v1/gate-entries', 'gate_entry', 'gateEntryNumber'], ['/v1/grns', 'grn', 'grnNumber'],
    ['/v1/qc-inspections', 'qc_tag', 'batchNumber'], ['/v1/rm-batches', 'rm_lot', 'batchNumber'], ['/v1/grn-containers', 'container', 'containerCode']]) {
    const block = near(shell, `'${ep}': [\n`, 6000);
    assert.match(block, new RegExp(`label: 'Print label'[^\\n]*stepLabel\\('${kind}'`), `${ep} Print label`);
    assert.match(block, new RegExp(`label: 'Reprint label'[^\\n]*stepLabel\\('${kind}'`), `${ep} Reprint label`);
    assert.match(near(shell, `${kind}: function (r)`, 600), new RegExp(`code: r\\.${code}`), `${kind} encodes ${code}`);
  }
  assert.doesNotMatch(shell, /openQrLabel\(/, 'no QR-only label left on the generic screens');
  // R3/R4 receiving audit result: GRN label (with the line decisions) and each new lot's quarantine tag
  const recv = near(fb, "toast('Audit saved · GRN '", 3000);
  assert.match(recv, /SB\('fb-grn', \{ labelKind: 'grn'/);
  assert.match(recv, /SB\('fb-q-' \+ i, \{ labelKind: 'rm_lot', subjectRef: x\.batchNumber, code: x\.batchNumber, title: 'QUARANTINE'/);
  assert.match(fb, /function SB\(id, o\) \{ return window\.RA && window\.RA\.stepButtons \? window\.RA\.stepButtons\(id, o\)/);
  // R6 putaway: raw-lot reprint with a reason; the bin label
  assert.match(fb, /id="fb-label-rp"/);
  assert.match(fb, /reprintReason: why/);
  assert.match(fb, /id="fb-binlabel"/);
  // R9 hold tag on every held lot
  assert.match(near(fb, 'async function viewRecall(', 3000), /SB\('fb-ht-' \+ i, \{ labelKind: 'hold_tag'/);
});
