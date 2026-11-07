/**
 * FLOOR-2 (F7, owner: the finished-goods rack "color coded and initial based"; production-floor plan
 * §1 "FG rack, QC approved, colour zone"). On a real Postgres.
 *
 *   - the admin gives an FG zone a colour (hex), the colour's NAME and initials; colour is never the
 *     only signal, so a name and initials are required, and no two zones share either;
 *   - a zone's colour or initials cannot change while finished goods sit in it (their labels would lie);
 *   - put-away to a zone picks a free bin IN that zone, and refuses a bin outside it;
 *   - the FG lot label carries the zone, the colour name and the initials;
 *   - the TV board shows each FG lot's zone with its colour name and initials.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { finishedGood, rack } from '../../../test-support/produce-fixtures.js';
import { FgZoneService } from '../shelf/fg-zone.service.js';
import { FgLabelService } from '../packaging-qc/fg-label.service.js';
import { ShelfTaskService } from '../shelf/shelf-task.service.js';
import { ShelfLayoutService } from '../shelf/shelf-layout.service.js';
import { PickLightService } from '../shelf/pick-light.service.js';
import { shelfDb } from '../shelf/shelf.tokens.js';
import { DisplayService } from '../floor-ops/display.service.js';
import { MacerationService } from '../floor-ops/maceration.service.js';

let zones: FgZoneService, labels: FgLabelService, shelf: ShelfTaskService, display: DisplayService;
const admin = principal({ roles: ['admin'], userId: '00000000-0000-7000-8000-00000000f101' });
const sql = () => testClient();
const letters = (n = 7) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

before(async () => {
  await ensureSchema();
  zones = new FgZoneService(sql());
  const db = shelfDb(sql());
  shelf = new ShelfTaskService(db, new ShelfLayoutService(db), new PickLightService(db));
  labels = new FgLabelService(sql(), shelf);
  display = new DisplayService(sql(), new MacerationService(sql()));
});
after(async () => closeTestClient());

async function zone() {
  const code = `FZ${randomUUID().slice(0, 6).toUpperCase()}`;
  const r = await rack({ zoneCode: code, shelves: 1, bins: 2 });
  return { code, bins: r.bins };
}

test('style: a colour, its plain name and initials; each required and checked; none shared by two zones', async () => {
  const z = await zone();
  const name = 'Teal' + letters().toLowerCase(), ini = letters(3);
  await assert.rejects(() => zones.set(z.code, { colourName: 'Sea-green', colourHex: '#2E8B57', initials: ini }, admin), /plain name/);
  await assert.rejects(() => zones.set(z.code, { colourName: name, colourHex: 'teal', initials: ini }, admin), /hex/);
  await assert.rejects(() => zones.set(z.code, { colourName: name, colourHex: '#2E8B57', initials: '' }, admin), /initials/i);
  await assert.rejects(() => zones.set(z.code, { colourName: name, colourHex: '#2E8B57', initials: 'ABCD' }, admin), /initials/i);
  await assert.rejects(() => zones.set(z.code, { colourName: '', colourHex: '#2E8B57', initials: ini }, admin), /plain name/);
  await assert.rejects(() => zones.set('NO-SUCH-ZONE', { colourName: name, colourHex: '#2E8B57', initials: ini }, admin), /No zone NO-SUCH-ZONE/);
  const saved = await zones.set(z.code.toLowerCase(), { colourName: name, colourHex: '#2e8b57', initials: ini.toLowerCase() }, admin);
  assert.deepEqual([saved.zoneCode, saved.colourName, saved.colourHex, saved.initials], [z.code, name, '#2E8B57', ini]);
  const listed = (await zones.list()).find((x) => x.zoneCode === z.code)!;
  assert.deepEqual([listed.colourName, listed.colourHex, listed.initials, listed.bins], [name, '#2E8B57', ini, 2]);
  const other = await zone();
  await assert.rejects(() => zones.set(other.code, { colourName: name.toUpperCase(), colourHex: '#112233', initials: letters(3) }, admin), /already/);
  await assert.rejects(() => zones.set(other.code, { colourName: 'Plum' + letters().toLowerCase(), colourHex: '#112233', initials: ini }, admin), /already/);
});

test('style: a zone\'s colour or initials cannot change while finished goods sit in it', async () => {
  const z = await zone();
  const name = 'Ochre' + letters().toLowerCase(), ini = letters(2);
  await zones.set(z.code, { colourName: name, colourHex: '#CC7722', initials: ini }, admin);
  const fg = await finishedGood({ coa: 'RELEASED' });
  const t = await shelf.ensurePutaway(fg.fgBatchId, admin, { zoneCode: z.code });
  await assert.rejects(() => zones.set(z.code, { colourName: 'Rust' + letters().toLowerCase(), colourHex: '#B7410E', initials: ini }, admin), /labelled/);
  await assert.rejects(() => zones.set(z.code, { colourName: name, colourHex: '#CC7722', initials: letters(2) }, admin), /labelled/);
  // the same style again is fine (an admin saving without a change)
  await zones.set(z.code, { colourName: name, colourHex: '#CC7722', initials: ini }, admin);
  assert.ok(t);
});

test('put-away to a zone: a free bin in that zone, never another; a bin outside the zone or a full zone is refused', async () => {
  const z = await zone();
  await zones.set(z.code, { colourName: 'Jade' + letters().toLowerCase(), colourHex: '#00A86B', initials: letters(2) }, admin);
  const a = await finishedGood({ coa: 'RELEASED' });
  const ta = (await shelf.ensurePutaway(a.fgBatchId, admin, { zoneCode: z.code })) as { bin: string | null };
  assert.ok(z.bins.includes(String(ta.bin)), `the target ${ta.bin} is in zone ${z.code}`);
  const b = await finishedGood({ coa: 'RELEASED' });
  const tb = (await shelf.ensurePutaway(b.fgBatchId, admin, { zoneCode: z.code })) as { bin: string | null };
  assert.ok(z.bins.includes(String(tb.bin)) && tb.bin !== ta.bin);
  const c = await finishedGood({ coa: 'RELEASED' });
  await assert.rejects(() => shelf.ensurePutaway(c.fgBatchId, admin, { zoneCode: z.code }), /No free bin in zone/);
  const elsewhere = await zone();
  await assert.rejects(() => shelf.ensurePutaway(c.fgBatchId, admin, { zoneCode: z.code, binCode: elsewhere.bins[0] }), /not in zone/);
  await assert.rejects(() => shelf.ensurePutaway(c.fgBatchId, admin, { zoneCode: 'NO-SUCH-ZONE' }), /No zone NO-SUCH-ZONE/);
});

test('FG lot label: the zone, the colour name and the initials print with the rack', async () => {
  const z = await zone();
  const name = 'Cobalt' + letters().toLowerCase(), ini = letters(2);
  await zones.set(z.code, { colourName: name, colourHex: '#0047AB', initials: ini }, admin);
  const fg = await finishedGood({ coa: 'RELEASED' });
  await shelf.ensurePutaway(fg.fgBatchId, admin, { zoneCode: z.code });
  const c = await labels.preview(fg.fgBatchId, admin);
  assert.deepEqual(c.zone, { code: z.code, name: 'Test zone', colourName: name, colourHex: '#0047AB', initials: ini });
  assert.ok(String(c.rack).length > 0);
  assert.deepEqual(await zones.forFgBatch(fg.fgBatchId), c.zone);
  // a zone the admin has not styled prints its code and says it has no colour: never a guessed colour
  const plain = await zone();
  const fg2 = await finishedGood({ coa: 'RELEASED' });
  await shelf.ensurePutaway(fg2.fgBatchId, admin, { zoneCode: plain.code });
  assert.deepEqual((await labels.preview(fg2.fgBatchId, admin)).zone, { code: plain.code, name: 'Test zone', colourName: null, colourHex: null, initials: null });
});

test('TV board: each FG lot on the rack shows its zone with the colour name and initials', async () => {
  const z = await zone();
  const name = 'Saffron' + letters().toLowerCase(), ini = letters(2);
  await zones.set(z.code, { colourName: name, colourHex: '#F4C430', initials: ini }, admin);
  const fg = await finishedGood({ coa: 'RELEASED' });
  await shelf.ensurePutaway(fg.fgBatchId, admin, { zoneCode: z.code });
  const f = await display.feed(null);
  const row = f.fgRack.find((x) => x.batchNumber === fg.fgBatchNo)!;
  assert.ok(row, 'the batch is on the board');
  assert.deepEqual([row.zoneCode, row.colourName, row.colourHex, row.initials, row.state], [z.code, name, '#F4C430', ini, 'GOING']);
  assert.ok(z.bins.includes(String(row.bin)));
});
