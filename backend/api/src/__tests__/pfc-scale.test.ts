/**
 * Lane pf-c (plan 12.5): scale pairing — floor-ops/scale.service.ts. Only STABLE readings are
 * captured, parsed to exact integer milligrams (no float), and a weight is recorded as "from
 * scale" only against a fresh stable reading from a scale at the same station; otherwise "typed".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient, principal } from '../../../test-support/db.js';
import { DevicesService } from '../floor-ops/devices.service.js';
import { ScaleService, parseScaleLine, SCALE_READING_FRESH_MS } from '../floor-ops/scale.service.js';

let now = new Date('2026-11-05T11:00:00Z');
const clock = () => now;
let devices: DevicesService;
let scales: ScaleService;
const admin = principal({ userId: randomUUID(), permissions: ['platform:device:write'] });

before(async () => {
  await ensureSchema();
  devices = new DevicesService(testClient(), clock);
  scales = new ScaleService(testClient(), clock);
});
after(async () => closeTestClient());

test('parse: common scale strings, stable vs unstable, exact mg', () => {
  assert.deepEqual(parseScaleLine('S S     125.47 g'), { mg: 125470, stable: true });   // Mettler SICS
  assert.deepEqual(parseScaleLine('S D     125.40 g'), { mg: 125400, stable: false });  // SICS dynamic
  assert.deepEqual(parseScaleLine('ST,+00125.47  g'), { mg: 125470, stable: true });    // A&D
  assert.deepEqual(parseScaleLine('US,+00125.47  g'), { mg: 125470, stable: false });
  assert.deepEqual(parseScaleLine('ST,GS,+  1.2500kg'), { mg: 1250000, stable: true });
  assert.deepEqual(parseScaleLine('    0.453 g ?'), { mg: 453, stable: false });         // Ohaus unstable marker
  assert.deepEqual(parseScaleLine('+0.1 g'), { mg: 100, stable: true });
  assert.deepEqual(parseScaleLine('350 mg'), { mg: 350, stable: true });
  assert.equal(parseScaleLine('OL'), null);
  assert.equal(parseScaleLine('ST,-00001.00 g'), null, 'a negative reading is not a weight');
  assert.equal(parseScaleLine('ST,+0.0001 g'), null, 'finer than a milligram is refused, not rounded');
  assert.equal(parseScaleLine('hello'), null);
});

async function scaleAt(station: string) {
  const r = await devices.create({ kind: 'scale', station, name: 'Lab scale', config: { resolutionMg: 10 } }, admin);
  return devices.authenticate((await devices.pair(r.pairing.code)).token);
}

test('record: an unstable reading is never stored; a stable one is, in mg', async () => {
  const st = `Pack ${randomUUID().slice(0, 6)}`;
  const s = await scaleAt(st);
  assert.deepEqual(await scales.record(s, { raw: 'S D 10.00 g' }), { stored: false, reason: 'not stable' });
  const ok = await scales.record(s, { raw: 'S S 10.05 g' });
  assert.equal(ok.stored, true);
  assert.equal(ok.mg, 10050);
  const latest = await scales.latest(st);
  assert.equal(latest!.mg, 10050);
  assert.equal(latest!.scaleReadingId, ok.scaleReadingId);
});

test('only a paired scale records readings', async () => {
  const r = await devices.create({ kind: 'kiosk', station: 'K', name: 'Tablet' }, admin);
  const k = await devices.authenticate((await devices.pair(r.pairing.code)).token);
  await assert.rejects(() => scales.record(k, { raw: 'S S 1 g' }), /scale/i);
});

test('resolveWeight: "from scale" must match a fresh stable reading at the same station; "typed" is recorded as typed', async () => {
  const st = `Pack ${randomUUID().slice(0, 6)}`;
  const s = await scaleAt(st);
  const rd = await scales.record(s, { raw: 'ST,+00050.00  g' });
  const w = await scales.resolveWeight({ mg: 50000, weightSource: 'scale', scaleReadingId: rd.scaleReadingId }, st);
  assert.deepEqual(w, { mg: 50000, weightSource: 'scale', scaleReadingId: rd.scaleReadingId });
  await assert.rejects(() => scales.resolveWeight({ mg: 50010, weightSource: 'scale', scaleReadingId: rd.scaleReadingId }, st), /does not match/);
  await assert.rejects(() => scales.resolveWeight({ mg: 50000, weightSource: 'scale', scaleReadingId: rd.scaleReadingId }, 'Another station'), /this station/);
  const t0 = now;
  now = new Date(now.getTime() + SCALE_READING_FRESH_MS + 1000);
  try {
    await assert.rejects(() => scales.resolveWeight({ mg: 50000, weightSource: 'scale', scaleReadingId: rd.scaleReadingId }, st), /old/);
  } finally {
    now = t0;
  }
  assert.deepEqual(await scales.resolveWeight({ mg: 1234, weightSource: 'typed' }, st), { mg: 1234, weightSource: 'typed', scaleReadingId: null });
  await assert.rejects(() => scales.resolveWeight({ mg: 12.5, weightSource: 'typed' }, st), /whole number/);
  await assert.rejects(() => scales.resolveWeight({ mg: 10, weightSource: 'guess' }, st), /scale or typed/);
});
