/**
 * FLOOR-FIX-16 — a real scale on the kiosk, through the browser's Web Serial API (Chrome, Edge).
 * Before this nothing read a physical scale: readings only arrived as HTTP lines, which only the
 * emulator sent. web/scale-serial.js runs here in a `vm` against a FAKE serial port: it opens the
 * port with the device's protocol and baud, splits lines across chunk boundaries, parses stable and
 * unstable flags and units into mg exactly as the server does, and posts stable lines through the
 * existing paired-scale route. The server refuses a protocol or baud it does not know.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { parseScaleLine, ScaleService } from '../floor-ops/scale.service.js';
import { DevicesService } from '../floor-ops/devices.service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: any = { TextDecoder, TextEncoder, ReadableStream, WritableStream, setTimeout, clearTimeout, Promise };
vm.runInNewContext(readFileSync(join(ROOT, 'web/scale-serial.js'), 'utf8'), ctx);
const S = ctx.RaScaleSerial;

before(ensureSchema);
after(closeTestClient);

const CORPUS: Array<[string, string]> = [
  ['sics', 'S S      125.47 g'], ['sics', 'S D      125.40 g'], ['sics', 'S I'], ['sics', 'S +'],
  ['and', 'ST,+00125.47  g'], ['and', 'US,+00125.40  g'], ['and', 'OL,+99999.99  g'], ['and', 'ST,+001.2345 kg'],
  ['ohaus', '    125.47 g'], ['ohaus', '    125.47 g ?'], ['generic', '1.250 kg'], ['generic', '-3.10 g'], ['generic', 'hello'],
  ['sartorius', '+     125.47 g  '], ['sartorius', '+     125.4      '],
];

test('the client parses every protocol exactly as the server stores it', () => {
  for (const [p, line] of CORPUS) {
    const c = S.parseLine(p, line), s = parseScaleLine(line);
    assert.deepEqual(c ? { mg: c.mg, stable: c.stable } : null, s, `${p}: ${JSON.stringify(line)}`);
  }
  assert.deepEqual(Object.keys(S.PROTOCOLS).sort(), ['and', 'generic', 'ohaus', 'sartorius', 'sics']);
  assert.equal(S.PROTOCOLS.and.serial.parity, 'even');
  assert.equal(S.PROTOCOLS.and.serial.dataBits, 7);
});

function fakePort(chunks: string[]) {
  const opened: unknown[] = [], written: string[] = [];
  const enc = new TextEncoder();
  let closed = false;
  return {
    opened, written, get closed() { return closed; },
    async open(o: unknown) { opened.push(o); },
    async close() { closed = true; },
    readable: new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }),
    writable: new WritableStream<Uint8Array>({ write(b) { written.push(new TextDecoder().decode(b)); } }),
  };
}

test('the reader opens the port with the configured baud, splits lines across chunks, and posts stable readings once', async () => {
  // SICS: the reader asks for repeated readings (SIR) and a line is split mid-number.
  const port = fakePort(['S D     12', '5.40 g\r\nS S     125.', '47 g\r\nS S     125.47 g\r\n', 'S S     130.00 g\r\nS I\r\n']);
  const seen: Array<{ mg: number; stable: boolean }> = [], posted: string[] = [];
  let t = 1_000_000;
  const r = S.createReader({ port, protocol: 'sics', settings: { baudRate: 4800 }, now: () => t, onReading: (x: { mg: number; stable: boolean }) => { seen.push({ mg: x.mg, stable: x.stable }); t += 100; }, post: async (raw: string) => { posted.push(raw); } });
  await r.run();
  assert.deepEqual(JSON.parse(JSON.stringify(port.opened)), [{ baudRate: 4800, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }]);
  assert.deepEqual(port.written, ['SIR\r\n']);
  assert.deepEqual(seen.map((x) => [x.mg, x.stable]), [[125400, false], [125470, true], [125470, true], [130000, true]]);
  assert.deepEqual(posted, ['S S     125.47 g', 'S S     130.00 g'], 'an unchanged stable weight is posted once, not every line');
  assert.ok(port.closed);
});

test('A&D defaults to 2400 7E1; a same weight is re-posted after 10 s so the server keeps a fresh reading', async () => {
  const port = fakePort(['ST,+00050.00  g\r\n', 'ST,+00050.00  g\r\n', 'ST,+00050.00  g\r\n']);
  const posted: string[] = [];
  let t = 0;
  await S.createReader({ port, protocol: 'and', now: () => t, onReading: () => { t += 6000; }, post: async (raw: string) => { posted.push(raw); } }).run();
  assert.deepEqual(JSON.parse(JSON.stringify(port.opened)), [{ baudRate: 2400, dataBits: 7, stopBits: 1, parity: 'even', flowControl: 'none' }]);
  assert.equal(posted.length, 2, 'posted at 0 s and again past 10 s');
});

test('posted lines land through the paired scale route; the scale device keeps a protocol and baud an admin can set', async () => {
  const devices = new DevicesService(testClient());
  const admin = principal({ userId: randomUUID(), roles: ['admin'] });
  const st = `SER ${randomUUID().slice(0, 6)}`;
  const d = await devices.create({ kind: 'scale', station: st, name: 'Bench scale', config: { category: 'floor', protocol: 'and', baudRate: 2400 } }, admin);
  assert.deepEqual([d.device.config.protocol, d.device.config.baudRate], ['and', 2400]);
  const plain = await devices.create({ kind: 'scale', station: st, name: 'Default' }, admin);
  assert.deepEqual([plain.device.config.protocol, plain.device.config.baudRate], ['generic', 9600]);
  await assert.rejects(() => devices.create({ kind: 'scale', station: st, name: 'x', config: { protocol: 'telepathy' } }, admin), /protocol/);
  await assert.rejects(() => devices.create({ kind: 'scale', station: st, name: 'x', config: { baudRate: 1234 } }, admin), /baud/);
  const scale = await devices.authenticate((await devices.pair(d.pairing.code)).token);
  const svc = new ScaleService(testClient());
  const port = fakePort(['US,+00050.10  g\r\nST,+00050.00  g\r\n']);
  await S.createReader({ port, protocol: 'and', now: () => 0, onReading: () => {}, post: (raw: string) => svc.record(scale, { raw }) }).run();
  const latest = await svc.latest(st);
  assert.equal(latest!.mg, 50000);
});

test('the kiosk loads the reader and offers Connect scale with a typed fallback', () => {
  const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  assert.ok(html.indexOf('/scale-serial.js') > 0 && html.indexOf('/scale-serial.js') < html.indexOf('/ws-floor-ops.js'));
  assert.match(readFileSync(join(ROOT, 'web/sw.js'), 'utf8'), /'\/scale-serial\.js'/);
  const ops = readFileSync(join(ROOT, 'web/ws-floor-ops.js'), 'utf8');
  assert.match(ops, /RaScaleSerial\.connect/);
  assert.match(ops, /fo-proto/);
});
