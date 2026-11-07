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

test('SCAN-11 finished flow: job ticket, MIXED reprint, batch label, maceration tags, QC-approved mark, FG lot, SHIPPED', () => {
  const fl = read('web/ws-floor.js'), fo = read('web/ws-floor-ops.js'), fb = read('web/ws-floorb.js'), shell = read('web/shell.js');
  // F1 a job ticket on every floor-queue row (its job number is what the verifier/mixer find field takes)
  assert.match(fl, /SB\('fl-jt-' \+ j\.floorJobId, \{ labelKind: 'floor_job', subjectRef: j\.jobNo, code: j\.jobNo/);
  // F4 MIXED reprint once the job is done (PICKED and VERIFIED already reprint at the next station)
  assert.match(fl, /id="fl-rpm-ref" data-scan/);
  assert.match(fl, /reprint\(data\(r\)\.floorJobId, 'MIXED'\)/);
  // F4 batch label + F5 maceration start and complete tags, on each run
  const mac = near(fo, 'async function viewMaceration(', 5000);
  assert.match(mac, /labelKind: 'oil_batch'/);
  assert.match(mac, /labelKind: 'maceration_start'[^}]*title: 'MACERATING'/);
  assert.match(mac, /labelKind: 'maceration_done'[^}]*title: 'MACERATION DONE'/);
  // F6 QC-approved mark once the last round approves
  assert.match(fb, /last && last\.decision === 'APPROVE' \? '<p>' \+ SB\('fb-qa', \{ labelKind: 'qc_approved'/);
  // F7 the FG lot label from the finished-goods screen
  assert.match(near(shell, "'/v1/finished-good-batches': [\n", 6000), /stepLabel\('fg_lot', r\)/);
  // F10 SHIPPED printed at handover, and reprintable
  assert.match(fo, /labelKind: 'shipped'[^}]*title: 'SHIPPED'/);
  assert.match(fo, /stepButtons\('fo-lg-shp', FV\.shipped\)/);
});

test('SCAN-12: where the next step chose from a list, it now also scans the label: PO, gate entry, oil batch', () => {
  const fb = read('web/ws-floorb.js');
  for (const id of ['fb-po', 'fb-gate', 'fb-qb']) {
    assert.match(fb, new RegExp(`scanPick\\('${id}'\\)`), `${id} has a scan field`);
  }
  const fn = near(fb, 'function scanPick(', 1500);
  assert.match(fn, /data-scan/);
  assert.match(fn, /RaScan\.onScan\(/);
  assert.match(fn, /dispatchEvent\(new Event\('change'/);
});
