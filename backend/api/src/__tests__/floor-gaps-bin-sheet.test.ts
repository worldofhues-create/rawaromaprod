/**
 * FLOOR-3 (R7): the bin-label sheet (Rack layout and Factory setup, "Print bin QR labels") printed
 * with no record at all, so a second sheet of the same bins (two labels per bin, a mis-shelving risk)
 * left no trace. It is now logged the way a single label is: the first sheet is a print job naming
 * the person; another sheet of the same bins is a REPRINT that needs a reason, kept with the person.
 * The sheet is an A4 office document, so it never goes to a station's thermal printer.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient, principal } from '../../../test-support/db.js';
import { DevicesService } from '../floor-ops/devices.service.js';
import { PrintService } from '../floor-ops/print.service.js';

let print: PrintService, devices: DevicesService;
const store = principal({ userId: randomUUID(), roles: ['warehouse'], permissions: ['platform:print_job:write', 'platform:print_job:read'] });
const other = principal({ userId: randomUUID(), roles: ['warehouse'], permissions: ['platform:print_job:write'] });

before(async () => {
  await ensureSchema();
  devices = new DevicesService(testClient());
  print = new PrintService(testClient(), devices);
});
after(async () => closeTestClient());

async function bins(n: number): Promise<string[]> {
  const t = randomUUID().slice(0, 6).toUpperCase(), out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const code = `BS${t}-${i}`;
    await testClient()`insert into location.bin_master (bin_id, bin_code, status) values (${randomUUID()}, ${code}, 'ACTIVE')`;
    out.push(code);
  }
  return out;
}

test('first sheet: logged as a bin_sheet print job with the person, the bins and no reprint', async () => {
  const b = await bins(3);
  const r = await print.binSheet({ binCodes: b, station: 'Office' }, store);
  assert.equal(r.reprint, false);
  assert.equal(r.bins, 3);
  assert.equal(r.job.labelKind, 'bin_sheet');
  assert.equal(r.job.status, 'browser');
  assert.equal(r.job.requestedBy, store.userId);
  assert.equal(r.job.reprintOf, null);
  assert.match(String(r.job.subjectRef), /^BINSHEET:/);
  const text = JSON.stringify(r.job.template.elements);
  assert.ok(text.includes(b[0]!) && text.includes(b[2]!), 'the job names the first and last bin');
});

test('the same bins again: refused without a reason; with one it is a REPRINT logged with the person and the reason', async () => {
  const b = await bins(4);
  const first = await print.binSheet({ binCodes: b, station: 'Office' }, store);
  await assert.rejects(() => print.binSheet({ binCodes: [...b].reverse(), station: 'Office' }, other), /already printed.*reason/i);
  const again = await print.binSheet({ binCodes: [...b].reverse(), station: 'Office', reason: 'Sheet ruined by solvent' }, other);
  assert.equal(again.reprint, true);
  assert.equal(again.job.reprintOf, first.job.printJobId);
  assert.equal(again.job.reprintReason, 'Sheet ruined by solvent');
  assert.equal(again.job.requestedBy, other.userId);
  assert.equal(again.job.template.reprint, true);
  assert.equal(again.job.subjectRef, first.job.subjectRef, 'order does not make it a different sheet');
  const hist = await print.list({ subjectRef: first.job.subjectRef });
  assert.deepEqual(hist.map((j) => [j.reprintReason, j.requestedBy]).reverse(), [[null, store.userId], ['Sheet ruined by solvent', other.userId]]);
  // a different set of bins is its own first sheet
  const fresh = await print.binSheet({ binCodes: b.slice(0, 2), station: 'Office' }, store);
  assert.equal(fresh.reprint, false);
});

test('refused: no bins, an unknown bin, an over-long reason; never sent to a station printer', async () => {
  await assert.rejects(() => print.binSheet({ binCodes: [], station: 'Office' }, store), /at least one bin/);
  await assert.rejects(() => print.binSheet({ binCodes: ['NO-SUCH-BIN-X'], station: 'Office' }, store), /No bin NO-SUCH-BIN-X/);
  const b = await bins(1);
  await print.binSheet({ binCodes: b, station: 'Office' }, store);
  await assert.rejects(() => print.binSheet({ binCodes: b, station: 'Office', reason: 'x'.repeat(301) }, store), /300/);
  const st = `Office ${randomUUID().slice(0, 4)}`;
  const d = await devices.create({ kind: 'label_printer', station: st, name: 'Zebra', config: { language: 'zpl', size: '100x50' } }, store);
  await devices.pair(d.pairing.code);
  const r = await print.binSheet({ binCodes: await bins(1), station: st }, store);
  assert.equal(r.job.deviceId, null, 'an A4 sheet is printed from the browser');
  assert.equal(r.job.status, 'browser');
});
