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
