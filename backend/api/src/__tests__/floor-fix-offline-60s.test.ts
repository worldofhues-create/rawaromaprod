/**
 * FLOOR-FIX-6 — a device is offline after 60 s without a heartbeat (production-floor plan §1.4). It
 * was 2 minutes, and the sweep ran once a minute, so a dead printer could go unflagged for 3. With a
 * 60 s window the senders must beat well inside it or every device flaps offline on network jitter,
 * and the device sweep must run often enough that 60 s means about 60 s.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'reflect-metadata';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { DevicesService, OFFLINE_AFTER_MS } from '../floor-ops/devices.service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
let now = new Date('2026-11-10T09:00:00Z');
before(ensureSchema);
after(closeTestClient);

test('the window is 60 s: silent 59 s is online, silent 61 s is swept offline', async () => {
  assert.equal(OFFLINE_AFTER_MS, 60_000);
  const svc = new DevicesService(testClient(), () => now);
  const admin = principal({ userId: randomUUID(), roles: ['admin'] });
  const r = await svc.create({ kind: 'label_printer', station: `HB ${randomUUID().slice(0, 6)}`, name: 'Zebra' }, admin);
  const dev = await svc.authenticate((await svc.pair(r.pairing.code)).token);
  await svc.heartbeat(dev);
  const t0 = now;
  now = new Date(t0.getTime() + 59_000);
  assert.ok(!(await svc.sweepOffline()).offline.includes(r.device.deviceId));
  assert.equal((await svc.list()).find((d) => d.deviceId === r.device.deviceId)!.online, true);
  now = new Date(t0.getTime() + 61_000);
  assert.ok((await svc.sweepOffline()).offline.includes(r.device.deviceId));
  assert.equal((await svc.list()).find((d) => d.deviceId === r.device.deviceId)!.online, false);
});

test('every heartbeat sender beats at most every 20 s, and the device sweep runs at most every 15 s', () => {
  const beats: [string, RegExp][] = [
    ['tools/print-agent/agent.mjs', /setInterval\(beat, ([\d_]+)\)/],
    ['web/ws-floor-ops.js', /setInterval\(beat, ([\d_]+)\)/],
    ['web/pair.js', /setInterval\(tick, ([\d_]+)\)/],
  ];
  for (const [f, re] of beats) {
    const m = re.exec(readFileSync(join(ROOT, f), 'utf8'));
    assert.ok(m, `${f} has a heartbeat interval`);
    assert.ok(Number(m![1]!.replace(/_/g, '')) <= 20_000, `${f} beats every ${m![1]} ms`);
  }
  const sweep = readFileSync(join(ROOT, 'backend/api/src/floor-ops/floor-sweep.service.ts'), 'utf8');
  const m = /@Interval\('device-sweep', ([\d_]+)\)/.exec(sweep);
  assert.ok(m && Number(m[1]!.replace(/_/g, '')) <= 15_000, 'a device sweep of its own, at most every 15 s');
});
