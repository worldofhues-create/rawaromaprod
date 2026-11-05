/**
 * Lane pf-c (plan section 2, 12.4): print jobs — floor-ops/print.service.ts. A job is queued to the
 * station's paired printer, pulled by the print agent, retried with backoff, parked after N
 * attempts (with an alert), reprinted only with a reason (marked REPRINT, logged with the person),
 * and printable in the browser when no agent is there.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient, principal } from '../../../test-support/db.js';
import { DevicesService } from '../floor-ops/devices.service.js';
import { PrintService } from '../floor-ops/print.service.js';

let now = new Date('2026-11-05T10:00:00Z');
const clock = () => now;
let devices: DevicesService;
let print: PrintService;
const person = principal({ userId: randomUUID(), roles: ['packing'], permissions: ['platform:print_job:write', 'platform:print_job:read'] });
const content = { brand: 'RAW AROMA CHEM', title: 'PACKED', lines: [['Order', 'SO-9'] as [string, string]], code: 'U-1' };

async function printerAt(station: string, config: Record<string, unknown> = { language: 'zpl', size: '75x50' }) {
  const r = await devices.create({ kind: 'label_printer', station, name: 'Zebra', config }, person);
  const p = await devices.pair(r.pairing.code);
  return { deviceId: r.device.deviceId, token: p.token, device: await devices.authenticate(p.token) };
}

before(async () => {
  await ensureSchema();
  devices = new DevicesService(testClient(), clock);
  print = new PrintService(testClient(), devices, clock);
});
after(async () => closeTestClient());

test('enqueue goes to the station printer at its size; the agent pulls it once and renders it in its language', async () => {
  const st = `Pack ${randomUUID().slice(0, 6)}`;
  const pr = await printerAt(st);
  const job = await print.enqueue({ station: st, labelKind: 'customer', subjectRef: 'U-1', content }, person);
  assert.equal(job.status, 'queued');
  assert.equal(job.deviceId, pr.deviceId);
  assert.equal(job.template.size, '75x50');
  const pulled = await print.claimNext(pr.device);
  assert.equal(pulled!.printJobId, job.printJobId);
  assert.equal(pulled!.language, 'zpl');
  assert.match(pulled!.rendered.body, /^\^XA/);
  assert.equal(await print.claimNext(pr.device), null, 'a sent job is not handed out twice');
  await print.report(pr.device, job.printJobId, { ok: true });
  assert.equal((await print.get(job.printJobId)).status, 'printed');
});

test('no printer paired at the station: the job is for the browser, with the template to print', async () => {
  const job = await print.enqueue({ station: `Nowhere ${randomUUID()}`, labelKind: 'carton', subjectRef: 'C-1', content, size: '100x150' }, person);
  assert.equal(job.status, 'browser');
  assert.equal(job.deviceId, null);
  assert.match(job.html, /ra-label/);
  const done = await print.markBrowserPrinted(job.printJobId, person);
  assert.equal(done.status, 'printed');
});

test('failure: retried with backoff, then parked after max attempts, raising an alert at the station', async () => {
  const st = `Pack ${randomUUID().slice(0, 6)}`;
  const pr = await printerAt(st, { language: 'tspl', size: '100x50' });
  const job = await print.enqueue({ station: st, labelKind: 'carton', subjectRef: 'C-2', content }, person);
  const t0 = now;
  try {
    for (let i = 1; i <= 5; i++) {
      const got = await print.claimNext(pr.device);
      assert.ok(got, `attempt ${i} handed out`);
      await print.report(pr.device, job.printJobId, { ok: false, error: 'paper out' });
      const j = await print.get(job.printJobId);
      if (i < 5) {
        assert.equal(j.status, 'failed');
        assert.equal(await print.claimNext(pr.device), null, 'not before the backoff');
        now = new Date(new Date(j.nextAttemptAt!).getTime() + 1000);
      } else {
        assert.equal(j.status, 'parked');
        assert.equal(j.lastError, 'paper out');
      }
    }
    const alerts = await devices.alerts(st);
    assert.ok(alerts.some((a) => a.kind === 'print_parked'));
    // An operator can send it again.
    const again = await print.retry(job.printJobId, person);
    assert.equal(again.status, 'queued');
  } finally {
    now = t0;
  }
});

test('a job the agent took and never answered goes back to the queue', async () => {
  const st = `Pack ${randomUUID().slice(0, 6)}`;
  const pr = await printerAt(st);
  const job = await print.enqueue({ station: st, labelKind: 'customer', subjectRef: 'U-9', content }, person);
  await print.claimNext(pr.device);
  const t0 = now;
  now = new Date(now.getTime() + 3 * 60 * 1000);
  try {
    await print.sweepStale();
    assert.equal((await print.get(job.printJobId)).status, 'failed');
  } finally {
    now = t0;
  }
});

test('reprint: only with a reason; a new job marked REPRINT pointing at the original, naming the person', async () => {
  const st = `Pack ${randomUUID().slice(0, 6)}`;
  const pr = await printerAt(st);
  const ref = `U-${randomUUID()}`;
  const job = await print.enqueue({ station: st, labelKind: 'customer', subjectRef: ref, content }, person);
  await assert.rejects(() => print.reprint(job.printJobId, '', person), /reason/i);
  const rp = await print.reprint(job.printJobId, 'label smudged', person);
  assert.equal(rp.reprintOf, job.printJobId);
  assert.equal(rp.reprintReason, 'label smudged');
  assert.equal(rp.requestedBy, person.userId);
  assert.equal(rp.template.reprint, true);
  assert.ok(rp.template.elements.some((e) => e.s === 'REPRINT'));
  const first = await print.claimNext(pr.device);
  assert.equal(first!.printJobId, job.printJobId, 'the original goes first (oldest first)');
  assert.doesNotMatch(first!.rendered.body, /REPRINT/);
  const pulled = await print.claimNext(pr.device);
  assert.equal(pulled!.printJobId, rp.printJobId);
  assert.match(pulled!.rendered.body, /REPRINT/);
  const history = await print.list({ subjectRef: ref });
  assert.equal(history.length, 2);
});

test('another station\'s printer cannot pull or answer the job', async () => {
  const a = await printerAt(`A ${randomUUID().slice(0, 6)}`);
  const b = await printerAt(`B ${randomUUID().slice(0, 6)}`);
  const job = await print.enqueue({ station: a.device.station, labelKind: 'customer', subjectRef: 'U-7', content }, person);
  assert.equal(await print.claimNext(b.device), null);
  await assert.rejects(() => print.report(b.device, job.printJobId, { ok: true }), /not this printer/i);
});
