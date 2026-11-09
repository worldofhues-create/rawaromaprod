/**
 * FLOOR-FIX-4 — scale precision by device category (owner decision): lab and QC scales read to
 * 0.01 g (10 mg), floor scales to 0.1 g (100 mg); weights are always stored in mg; an admin can
 * override one device. Display is at most 2 decimals, g or kg chosen from the size (web/weight.js).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import 'reflect-metadata';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { DevicesService } from '../floor-ops/devices.service.js';
import { ScaleService, scaleResolutionMg, SCALE_PRECISION_MG } from '../floor-ops/scale.service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: any = {};
vm.runInNewContext(readFileSync(join(ROOT, 'web/weight.js'), 'utf8'), ctx);
const W = ctx.RaWeight;

before(ensureSchema);
after(closeTestClient);
const admin = principal({ userId: randomUUID(), roles: ['admin'] });

test('defaults: lab and QC 10 mg, floor 100 mg; no category reads as floor; an override wins', () => {
  assert.deepEqual(SCALE_PRECISION_MG, { lab: 10, qc: 10, floor: 100 });
  assert.equal(scaleResolutionMg({ category: 'lab' }), 10);
  assert.equal(scaleResolutionMg({ category: 'qc' }), 10);
  assert.equal(scaleResolutionMg({ category: 'floor' }), 100);
  assert.equal(scaleResolutionMg({}), 100);
  assert.equal(scaleResolutionMg({ category: 'lab', resolutionMg: 1 }), 1);
  assert.equal(scaleResolutionMg({ category: 'floor', resolutionMg: 0 }), 100, 'a nonsense override is ignored');
});

test('a scale is created with its category default, an admin overrides one device, latest() reports it', async () => {
  const devices = new DevicesService(testClient());
  const st = `Lab ${randomUUID().slice(0, 6)}`;
  const lab = await devices.create({ kind: 'scale', station: st, name: 'Lab balance', config: { category: 'lab' } }, admin);
  assert.equal(lab.device.config.category, 'lab');
  assert.equal(lab.device.config.resolutionMg, 10);
  const floor = await devices.create({ kind: 'scale', station: `F ${st}`, name: 'Floor scale' }, admin);
  assert.equal(floor.device.config.category, 'floor');
  assert.equal(floor.device.config.resolutionMg, 100);
  await assert.rejects(() => devices.create({ kind: 'scale', station: st, name: 'x', config: { category: 'kitchen' } }, admin), /lab, qc or floor/);
  const over = await devices.update(lab.device.deviceId, { config: { category: 'lab', resolutionMg: 1 } });
  assert.equal(over.config.resolutionMg, 1);
  assert.equal(over.config.resolutionOverride, true);
  const s = await devices.authenticate((await devices.pair(lab.pairing.code)).token);
  await new ScaleService(testClient()).record(s, { raw: 'ST,+00125.471 g' });
  assert.equal((await new ScaleService(testClient()).latest(st))!.resolutionMg, 1);
});

test('display: at most 2 decimals, never finer than the scale, g or kg by size', () => {
  assert.equal(W.formatWeight(125471, 'g', 10), '125.47 g');
  assert.equal(W.formatWeight(125471, 'g', 100), '125.5 g');
  assert.equal(W.formatWeight(125471, 'g', 1), '125.47 g');
  assert.equal(W.formatWeight(1254710, 'g', 100), '1.25 kg');
  assert.equal(W.formatWeight(450, 'g', 10), '0.45 g');
});
