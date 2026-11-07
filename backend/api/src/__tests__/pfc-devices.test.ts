/**
 * Lane pf-c (plan section 2): device registry and pairing — floor/devices.service.ts.
 * Real Postgres. A clock is injected so the 10-minute code window and the offline sweep are
 * tested without waiting.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient, principal } from '../../../test-support/db.js';
import { DevicesService, PAIRING_TTL_MS, OFFLINE_AFTER_MS } from '../floor-ops/devices.service.js';

let now = new Date('2026-11-05T09:00:00Z');
const clock = () => now;
let svc: DevicesService;
const admin = principal({ userId: randomUUID(), roles: ['admin'], permissions: ['platform:device:write', 'platform:device:read'] });
const station = () => `Picker bay ${randomUUID().slice(0, 6)}`;

before(async () => {
  await ensureSchema();
  svc = new DevicesService(testClient(), clock);
});
after(async () => closeTestClient());

test('add device: a 6-digit code valid for 10 minutes; only its hash is stored', async () => {
  const r = await svc.create({ kind: 'label_printer', station: station(), name: 'Zebra ZD421', config: { language: 'ZPL', size: '100x50' } }, admin);
  assert.match(r.pairing.code, /^\d{6}$/);
  assert.equal(new Date(r.pairing.expiresAt).getTime() - now.getTime(), PAIRING_TTL_MS);
  assert.equal(PAIRING_TTL_MS, 10 * 60 * 1000);
  assert.equal(r.device.status, 'pending');
  const rows = await testClient()`select code_hash from platform.device_pairing where device_id = ${r.device.deviceId}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.code_hash, createHash('sha256').update(r.pairing.code).digest('hex'));
  assert.ok(!JSON.stringify(rows).includes(r.pairing.code));
});

test('pair: the code gives a station-scoped token once; the code cannot be used again', async () => {
  const st = station();
  const r = await svc.create({ kind: 'kiosk', station: st, name: 'Tablet 1' }, admin);
  const p = await svc.pair(r.pairing.code);
  assert.match(p.token, /^rdt_[A-Za-z0-9_-]{40,}$/);
  assert.equal(p.device.station, st);
  assert.equal(p.device.kind, 'kiosk');
  const tok = await testClient()`select token_hash, station from platform.device_token where device_id = ${r.device.deviceId}`;
  assert.equal(tok.length, 1);
  assert.equal(tok[0]!.station, st);
  assert.equal(tok[0]!.token_hash, createHash('sha256').update(p.token).digest('hex'));
  await assert.rejects(() => svc.pair(r.pairing.code), /not valid/i);
  const me = await svc.authenticate(p.token);
  assert.equal(me.deviceId, r.device.deviceId);
  assert.equal(me.station, st);
});

test('pair: an expired code is refused', async () => {
  const r = await svc.create({ kind: 'display', station: station(), name: 'TV' }, admin);
  now = new Date(now.getTime() + PAIRING_TTL_MS + 1000);
  try {
    await assert.rejects(() => svc.pair(r.pairing.code), /not valid/i);
  } finally {
    now = new Date(now.getTime() - PAIRING_TTL_MS - 1000);
  }
});

test('pair: a wrong or malformed code is refused', async () => {
  await assert.rejects(() => svc.pair('12'), /6 digits/);
  await assert.rejects(() => svc.pair('000000'), /not valid/i);
});

test('a new code for a device replaces the old one, and re-pairing revokes the old token', async () => {
  const r = await svc.create({ kind: 'label_printer', station: station(), name: 'TSC' }, admin);
  const first = await svc.pair(r.pairing.code);
  const again = await svc.newPairingCode(r.device.deviceId, admin);
  const second = await svc.pair(again.code);
  await assert.rejects(() => svc.authenticate(first.token), /not recognised|revoked/i);
  assert.equal((await svc.authenticate(second.token)).deviceId, r.device.deviceId);
});

test('revoke: instant — the token stops working and the device cannot be paired again with an old code', async () => {
  const r = await svc.create({ kind: 'kiosk', station: station(), name: 'Tablet 2' }, admin);
  const p = await svc.pair(r.pairing.code);
  const code2 = await svc.newPairingCode(r.device.deviceId, admin);
  await svc.revoke(r.device.deviceId, admin);
  await assert.rejects(() => svc.authenticate(p.token), /not recognised|revoked/i);
  await assert.rejects(() => svc.pair(code2.code), /not valid/i);
  await assert.rejects(() => svc.newPairingCode(r.device.deviceId, admin), /revoked/i);
});

test('heartbeat + offline sweep: silent for over the window -> offline and an alert at its station; a heartbeat clears it', async () => {
  const st = station();
  const r = await svc.create({ kind: 'label_printer', station: st, name: 'Honeywell' }, admin);
  const p = await svc.pair(r.pairing.code);
  const dev = await svc.authenticate(p.token);
  await svc.heartbeat(dev);
  now = new Date(now.getTime() + OFFLINE_AFTER_MS + 5000);
  try {
    const swept = await svc.sweepOffline();
    assert.ok(swept.offline.includes(r.device.deviceId));
    const alerts = await svc.alerts(st);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'device_offline');
    assert.match(String(alerts[0]!.title), /Honeywell/);
    // A second sweep does not raise a second alert.
    await svc.sweepOffline();
    assert.equal((await svc.alerts(st)).length, 1);
    const listed = (await svc.list()).find((d) => d.deviceId === r.device.deviceId)!;
    assert.equal(listed.status, 'offline');
    assert.equal(listed.online, false);
    await svc.heartbeat(await svc.authenticate(p.token));
    assert.equal((await svc.alerts(st)).length, 0);
    const back = (await svc.list()).find((d) => d.deviceId === r.device.deviceId)!;
    assert.equal(back.status, 'active');
    assert.equal(back.online, true);
  } finally {
    now = new Date('2026-11-05T09:00:00Z');
  }
});

test('create: validates kind, station and name', async () => {
  await assert.rejects(() => svc.create({ kind: 'toaster', station: 'X', name: 'Y' } as never, admin), /kind/);
  await assert.rejects(() => svc.create({ kind: 'kiosk', station: '', name: 'Y' }, admin), /station/);
  await assert.rejects(() => svc.create({ kind: 'kiosk', station: 'X', name: '' }, admin), /name/);
});

test('list never returns a token or code hash', async () => {
  const items = await svc.list();
  const text = JSON.stringify(items);
  assert.ok(!/token_hash|tokenHash|code_hash|codeHash/.test(text));
});

// SCAN-4: a scanner is recorded per station with the symbologies it reads, for the Devices screen.
// A wedge or Bluetooth scanner types into the station's own screen: it has no token to pair with and
// no heartbeat, so it is active at once and never swept offline.
test('scanner: recorded per station with its symbologies; no pairing code; never swept offline', async () => {
  const st = station();
  const r = await svc.create({ kind: 'scanner', station: st, name: 'Honeywell 1472g', config: { symbologies: ['qr_code', 'code_128'], connection: 'usb_wedge', aimPrefix: true, suffix: 'enter' } }, admin);
  assert.equal(r.device.kind, 'scanner');
  assert.equal(r.device.status, 'active');
  assert.equal(r.pairing, null);
  assert.deepEqual(r.device.config.symbologies, ['qr_code', 'code_128']);
  const codes = await testClient()`select 1 from platform.device_pairing where device_id = ${r.device.deviceId}`;
  assert.equal(codes.length, 0);
  now = new Date(now.getTime() + OFFLINE_AFTER_MS * 10);
  const sw = await svc.sweepOffline();
  assert.ok(!sw.offline.includes(r.device.deviceId));
  const listed = (await svc.list()).find((d) => d.deviceId === r.device.deviceId)!;
  assert.equal(listed.status, 'active');
  await assert.rejects(() => svc.newPairingCode(r.device.deviceId, admin), /scanner/i);
  const upd = await svc.update(r.device.deviceId, { config: { symbologies: ['qr_code'] } });
  assert.deepEqual(upd.config.symbologies, ['qr_code']);
});

test('scanner: symbologies are required and must be ones the floor uses', async () => {
  await assert.rejects(() => svc.create({ kind: 'scanner', station: station(), name: 'S1' }, admin), /symbolog/i);
  await assert.rejects(() => svc.create({ kind: 'scanner', station: station(), name: 'S1', config: { symbologies: [] } }, admin), /symbolog/i);
  await assert.rejects(() => svc.create({ kind: 'scanner', station: station(), name: 'S1', config: { symbologies: ['qr_code', 'telepathy'] } }, admin), /telepathy/);
  const r = await svc.create({ kind: 'scanner', station: station(), name: 'S1', config: { symbologies: ['code_128'] } }, admin);
  await assert.rejects(() => svc.update(r.device.deviceId, { config: { symbologies: ['nope'] } }), /nope/);
});
