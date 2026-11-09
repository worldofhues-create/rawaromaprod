/* JOURNEY-FIX-RP-2 (walked 2026-11-10 with a paired printer at the Floor station): the PICKED,
 * VERIFIED and MIXED hand-off labels opened a browser print window every time. They never became
 * print jobs, so a printer paired at the station never printed them, the Print queue had no history
 * of them, and a reprint's REPRINT was a browser page nobody logged. Every other step's label goes
 * through RA.stepPrint (a print job: the paired printer, or the browser when none is). These do too. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const fl = readFileSync(join(root, 'web/ws-floor.js'), 'utf8');
const body = (name: string) => { const i = fl.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return fl.slice(i, fl.indexOf('\n  }\n', i)); };

test('PICKED / VERIFIED / MIXED print as station print jobs at Floor, with the code the next station scans', () => {
  const p = body('printLabel');
  assert.match(p, /window\.RA\.stepPrint\(/, 'goes through the print queue');
  assert.match(p, /labelKind: 'floor_' \+ String\(l\.kind\)\.toLowerCase\(\)/);
  assert.match(p, /defaultStation: 'Floor'/);
  assert.match(p, /code: payload/);
  assert.match(p, /REPRINT/, 'a reprint still says so on the label');
  // refused (a role without platform:print_job:write) or failed: the browser label, never no label
  assert.match(p, /if \(!job\) printLabel\(Object\.assign\(\{\}, l, \{ _browser: true \}\)\)/);
  assert.match(p, /window\.open\(/);
});
