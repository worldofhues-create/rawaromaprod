/**
 * IMPORT-RP-COST (LD-156) — a material's purchase price: the sheet, the export of what is on file,
 * the single price typed on screen, and the fact ALEMBIC's Books receive. Real Postgres, the real
 * services, the real bridge relay signing to a stub. Every material, supplier and price is made up.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ImportEngine, readImportFile, readImportTable, toCsv, cellRupees, type ImportJobResult } from '@core/backend-kernel';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { MaterialImportService } from '../floor/material-import.service.js';
import { BridgeRelayService } from '../bridge/relay.service.js';
import { OUTBOUND_TO_ALEMBIC, validateEnvelope } from '../bridge/contract.js';
import { sealSecret } from '../bridge/secret-box.js';
import { verifyBody } from '../bridge/signing.js';
import { factoryKinds } from '../imports/factory-kinds.js';
import { MATERIAL_PURCHASE_PRICES } from '../imports/kind-specs.js';
import { MATERIAL_COST_RECORDED, PurchasePriceService, netPaise, priceUnit } from '../imports/purchase-price.service.js';
import { ensureSchema, testClient, bridgeDb, principal, closeTestClient } from '../../../test-support/db.js';
import { ROLES } from '../../../../scripts/ra-roles.js';

const sql = () => testClient();
const t = () => crypto.randomUUID().slice(0, 6).toUpperCase();
const P = MATERIAL_PURCHASE_PRICES.permission;
const buyer = principal({ userId: '00000000-0000-7000-8000-0000000000b1', roles: ['procurement'], permissions: [P, 'masterdata:material_import:write', 'procurement:vendor_import:write'] });
const finance = principal({ userId: '00000000-0000-7000-8000-0000000000b2', roles: ['finance'], permissions: [P] });
const picker = principal({ userId: '00000000-0000-7000-8000-0000000000b3', roles: ['picker'], permissions: [] });
const today = '2026-11-13';
const ctx = (p = buyer) => ({ principal: p, today });
const csv = (rows: string[][]) => Buffer.from(toCsv(rows), 'utf8');
const rowOf = (r: ImportJobResult, n: number) => r.rows.find((x) => x.row === n)!;
const HEAD = MATERIAL_PURCHASE_PRICES.columns.map((c) => c.header);
const SECRET = 'cost-fact-test-secret';
const WEBHOOK = 'https://alembic.example.test/api/v1/bridge/rawprod/webhooks/in';
const TENANT = '0f1e2d3c-4b5a-4968-8776-655443322110';

let prices: PurchasePriceService;
let engine: ImportEngine;
let relay: BridgeRelayService;
const run = t();
const M = { a: `PP-A-${run}`, b: `PP-B-${run}`, c: `PP-C-${run}`, d: `PP-D-${run}` };
const S = { code: `PPV-${run}`, name: `Made-up Aromatics ${run}` };

before(async () => {
  await ensureSchema();
  prices = new PurchasePriceService(sql());
  engine = new ImportEngine(sql(), 'platform', factoryKinds(sql(), new MaterialImportService(sql(), new FloorCodeService(sql())), prices));
  for (const u of ['kg', 'g', 'pcs']) await sql()`insert into platform.uom_master (uom_code, uom_name, status) values (${u}, ${u}, 'ACTIVE') on conflict (uom_code) do nothing`;
  const imp = async (kind: string, rows: string[][]) => { const bytes = csv(rows); const pre = await engine.preview(kind, { bytes }, ctx()); assert.equal(pre.commitRefusal.all_or_nothing, null, JSON.stringify(pre.rows)); await engine.commit(pre.job.importJobId, { bytes }, ctx()); };
  await imp('suppliers', [['Supplier code', 'Name'], [S.code, S.name]]);
  await imp('ingredients', [['Code', 'Name', 'Unit', 'Default supplier'], [M.a, `Made-up aldehyde ${run}`, 'kg', S.code], [M.b, `Made-up musk ${run}`, 'g', ''], [M.c, `Made-up cap ${run}`, 'pcs', ''], [M.d, `Made-up resin ${run}`, '', '']]);
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  await sql()`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed) values ('default', true, ${WEBHOOK}, ${sealSecret(SECRET)})
              on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url, hmac_secret_sealed = excluded.hmac_secret_sealed`;
  // As production: the deployment's ALEMBIC tenant is configured (STK-26), so a fact not tied to a requirement has its org.
  relay = new BridgeRelayService(bridgeDb(), { get: (k: string) => (k === 'ALEMBIC_ASSERTION_TENANT_ID' ? TENANT : undefined) } as never);
});
after(async () => { relay?.onModuleDestroy(); await closeTestClient(); });

const facts = async () => sql()`select o.id::text as id, o.aggregate_id::text as aggregate_id, o.payload from bridge.outbox o where o.type = ${MATERIAL_COST_RECORDED} and o.payload->>'material_code' like ${'PP-%-' + run} order by o.seq`;

test('money: rupees become integer paise once; the net price is list less discount, rounded once, half up to the paisa', () => {
  const paise = (s: string) => { const c = cellRupees(s, 'Price'); return c.ok ? c.value : c.problem; };
  assert.equal(paise('1,250.50'), 125050n);
  assert.equal(paise('₹ 500'), 50000n);
  assert.equal(paise('Rs. 80.5'), 8050n);
  assert.equal(paise(''), null);
  assert.match(String(paise('12.345')), /two decimals at most/);
  assert.match(String(paise('-5')), /below zero/);
  assert.match(String(paise('1e3')), /not an amount/);
  assert.equal(netPaise(125050n, 500), 118798n); // 1250.50 less 5% = 1187.975 -> 1187.98 (half up)
  assert.equal(netPaise(100n, 3333), 67n); // 1.00 less 33.33% = 0.6667
  assert.equal(netPaise(999n, 5000), 500n); // 4.995 -> 5.00
  assert.equal(netPaise(12345n, 0), 12345n);
  assert.equal(netPaise(12345n, 10000), 0n);
  assert.deepEqual(['KG', 'gm', 'Ltr', 'ML', 'pcs', 'drum'].map(priceUnit), ['kg', 'g', 'L', 'ml', 'unit', null]);
});

test('who: purchasing and finance hold the one permission (sheet and screen alike); the floor does not', async () => {
  const holders = ROLES.filter((r) => r.select(P)).map((r) => r.code).sort();
  assert.deepEqual(holders, ['finance', 'owner', 'procurement']);
  assert.deepEqual(engine.kindsFor(finance).map((k) => [k.kind, k.exportable]), [['material-purchase-prices', true]]);
  assert.deepEqual(engine.kindsFor(picker), []);
  await assert.rejects(() => engine.exportFilled('material-purchase-prices', 'xlsx', ctx(picker)), (e: { status?: number }) => e.status === 403);
  // A kind with no update rule has no export of what is on file.
  await assert.rejects(() => engine.exportFilled('ingredients', 'xlsx', ctx()), (e: { status?: number; message?: string }) => e.status === 404 && /no export/.test(String(e.message)));
});

test('export what is on file, fill in the prices, upload it back: only the filled rows are recorded, each with its fact for Books', async () => {
  const out = await engine.exportFilled('material-purchase-prices', 'xlsx', ctx());
  assert.equal(out.fileName, 'material-purchase-prices-on-file.xlsx');
  const file = readImportFile(Buffer.from(out.base64, 'base64'));
  assert.equal(file.ok, true);
  if (!file.ok) return;
  assert.deepEqual(file.table[0], HEAD);
  // A workbook row stops at its last filled cell: read each one out to the sheet's full width.
  const mine = file.table.filter((r) => String(r[0]).endsWith(run)).map((r) => HEAD.map((_, i) => r[i] ?? ''));
  assert.deepEqual(mine.map((r) => r.slice(0, 5)), [
    [M.a, `Made-up aldehyde ${run}`, 'kg', S.code, ''], // its unit and its preferred supplier come filled; the price is for the person
    [M.b, `Made-up musk ${run}`, 'g', '', ''],
    [M.c, `Made-up cap ${run}`, 'unit', '', ''],
    [M.d, `Made-up resin ${run}`, '', '', ''],
  ]);
  // Uploaded back untouched: every row has an empty price, so nothing changes and nothing can be committed.
  const untouched = await engine.preview('material-purchase-prices', { bytes: csv([HEAD, ...mine]) }, ctx());
  assert.deepEqual(untouched.job.counts, { rows: 4, create: 0, update: 0, skip: 4, refuse: 0 });
  assert.match(rowOf(untouched, 2).problems[0]!, /No price is given, so nothing changes/);
  assert.match(untouched.commitRefusal.valid_only!, /already on file|nothing to import/i);

  // The person fills two rows and leaves two.
  const filled = mine.map((r) => [...r]);
  filled[0] = [M.a, 'whatever is typed here is not imported', 'kg', S.code, '1,250.50', '5', '18', '2912', '01/11/2026', 'Quotation Q-17'];
  filled[1] = [M.b, '', '', '', '₹ 80', '', '', '', '2026-11-10', ''];
  const bytes = csv([HEAD, ...filled]);
  const before = (await facts()).length;
  const pre = await engine.preview('material-purchase-prices', { bytes, fileName: 'prices.csv' }, ctx(finance));
  assert.deepEqual(pre.job.counts, { rows: 4, create: 2, update: 0, skip: 2, refuse: 0 });
  assert.match(rowOf(pre, 2).notes.join(' '), /Net Rs 1187\.98 per kg/);
  assert.equal((await facts()).length, before, 'a preview sends nothing');
  const done = await engine.commit(pre.job.importJobId, { bytes }, ctx(finance));
  assert.deepEqual(done.job.written, { rows: 4, create: 2, update: 0, skip: 2, refuse: 0 });

  const rows = await sql()`select m.material_code as code, p.unit, p.list_price_paise::text as list, p.discount_bps as bps, p.net_price_paise::text as net, p.gst_rate_pct::text as gst, p.hsn_code as hsn,
                                  p.effective_from::text as eff, p.note, p.source, p.job_ref::text as job, p.created_by, v.vendor_code
                             from procurement.material_purchase_price p join masterdata.material m on m.material_id = p.material_id left join procurement.vendor_details v on v.vendor_id = p.vendor_id
                            where m.material_code = any(${[M.a, M.b]}) order by m.material_code`;
  assert.deepEqual(rows.map((r) => [r.code, r.unit, r.list, r.bps, r.net, r.gst === null ? null : Number(r.gst), r.hsn, r.eff.slice(0, 10), r.note, r.source, r.job, r.created_by, r.vendor_code]), [
    [M.a, 'kg', '125050', 500, '118798', 18, '2912', '2026-11-01', 'Quotation Q-17', 'import', pre.job.importJobId, finance.userId, S.code],
    [M.b, 'g', '8000', 0, '8000', null, null, '2026-11-10', null, 'import', pre.job.importJobId, finance.userId, null],
  ]);

  // The fact: one per price row, in the same transaction, body exactly as the contract names it.
  const sent = await facts();
  assert.equal(sent.length, before + 2);
  const a = sent.find((f) => (f.payload as { material_code: string }).material_code === M.a)!;
  assert.deepEqual(a.payload, {
    material_code: M.a, material_name: `Made-up aldehyde ${run}`, unit: 'kg', supplier_code: S.code, supplier_name: S.name,
    list_price_paise_per_unit: 125050, purchase_discount_bps: 500, net_price_paise_per_unit: 118798,
    gst_rate_pct: 18, hsn_code: '2912', effective_from: '2026-11-01', source: 'import', job_ref: pre.job.importJobId,
  });
  const b = sent.find((f) => (f.payload as { material_code: string }).material_code === M.b)!;
  assert.deepEqual([b.payload.supplier_code, b.payload.supplier_name, b.payload.gst_rate_pct, b.payload.hsn_code, b.payload.unit], [null, null, null, null, 'g']);
  assert.deepEqual(Object.keys(a.payload as object).sort(), ['effective_from', 'gst_rate_pct', 'hsn_code', 'job_ref', 'list_price_paise_per_unit', 'material_code', 'material_name', 'net_price_paise_per_unit', 'purchase_discount_bps', 'source', 'supplier_code', 'supplier_name', 'unit']);
  assert.equal(JSON.stringify(sent).includes(finance.userId), false, 'no person is named in a fact');

  // The same file again: answered with the import it was. The same rows in a new file: skipped. No new fact either way.
  assert.equal((await engine.preview('material-purchase-prices', { bytes }, ctx(finance))).alreadyImported, true);
  const again = await engine.preview('material-purchase-prices', { bytes: csv([HEAD, ...filled, [M.d, '', '', '', '', '', '', '', '', '']]) }, ctx());
  assert.deepEqual(again.job.counts, { rows: 5, create: 0, update: 0, skip: 5, refuse: 0 });
  assert.match(rowOf(again, 2).problems[0]!, /already on file from this date/);
  assert.equal((await facts()).length, before + 2);

  // The export now carries the price in force, and uploading that export untouched changes nothing.
  const out2 = readImportFile(Buffer.from((await engine.exportFilled('material-purchase-prices', 'csv', ctx())).base64, 'base64'));
  assert.equal(out2.ok, true);
  if (out2.ok) {
    const now = out2.table.filter((r) => String(r[0]).endsWith(run)).map((r) => HEAD.map((_, i) => r[i] ?? ''));
    assert.deepEqual(now[0], [M.a, `Made-up aldehyde ${run}`, 'kg', S.code, '1250.50', '5', '18', '2912', '01/11/2026', 'Quotation Q-17']);
    const round = await engine.preview('material-purchase-prices', { bytes: csv([HEAD, ...now]) }, ctx());
    assert.deepEqual(round.job.counts, { rows: 4, create: 0, update: 0, skip: 4, refuse: 0 });
    const t2 = readImportTable(MATERIAL_PURCHASE_PRICES, out2.table);
    assert.equal(t2.ok, true);
  }
});

test('the history is append-only: a later date supersedes, a past price is never rewritten, a large change is listed and not refused', async () => {
  const pre = await engine.preview('material-purchase-prices', { bytes: csv([HEAD,
    [M.a, '', 'kg', S.code, '1300', '5', '18', '2912', '01/11/2026', ''],          // a different price for a date on file
    [M.a, '', 'kg', S.code, '1900', '5', '18', '2912', '01/12/2026', 'new list'],  // a later date: supersedes, and a large change
    [M.a, '', 'kg', S.code, '1290', '5', '', '', '15/11/2026', ''],                // a small change: no flag
    [M.a, '', 'kg', '', '1100', '', '', '', '01/11/2026', ''],                     // no supplier named is its own key
    [M.a, '', 'g', S.code, '1.30', '', '', '', '20/11/2026', ''],                  // another unit: not compared
  ]) }, ctx());
  assert.match(rowOf(pre, 2).problems.join(' '), /A price from 2026-11-01 is already on file .*Rs 1250\.50 per kg, 5% discount.*never rewritten: give a later effective date/);
  assert.equal(rowOf(pre, 3).outcome, 'create');
  assert.match(rowOf(pre, 3).notes.join(' '), /Large change: the net price goes up 51\.9% \(Rs 1187\.98 to Rs 1805\.00 per kg\)\. The limit is 20%/);
  assert.equal(rowOf(pre, 4).outcome, 'create');
  assert.equal(rowOf(pre, 4).notes.some((n) => /Large change/.test(n)), false);
  assert.equal(rowOf(pre, 5).outcome, 'create');
  assert.match(rowOf(pre, 6).notes.join(' '), /in force is per kg and this one is per g, so the two are not compared/);

  // The limit is settable, by the people who hold the permission, and it changes what a preview lists.
  assert.equal(await prices.largeChangePct(), 20);
  await assert.rejects(() => prices.setLargeChangePct(0, buyer), /more than 0/);
  await prices.setLargeChangePct(5, buyer);
  const tighter = await engine.preview('material-purchase-prices', { bytes: csv([HEAD, [M.a, '', 'kg', S.code, '1350', '5', '', '', '15/11/2026', '']]) }, ctx());
  assert.match(rowOf(tighter, 2).notes.join(' '), /Large change: the net price goes up 8\.0%.*The limit is 5%/);
  await prices.setLargeChangePct(20, buyer);

  // The database refuses a rewrite whatever the code does: the key is unique, and the app role gets no UPDATE.
  const [row] = await sql()`select material_id, vendor_id from procurement.material_purchase_price p join masterdata.material m using (material_id) where m.material_code = ${M.a} limit 1`;
  await assert.rejects(() => sql()`insert into procurement.material_purchase_price (material_purchase_price_id, material_id, vendor_id, unit, list_price_paise, net_price_paise, effective_from, source, created_by)
                                    values (gen_random_uuid(), ${row!.material_id}, ${row!.vendor_id}, 'kg', 1, 1, '2026-11-01', 'screen', 'x')`, /material_purchase_price_key_uq/);
});

test('refusals, each in plain words: zero, below zero, three decimals, a discount over 100%, a date too far ahead, no date, an unknown material, supplier or unit', async () => {
  const pre = await engine.preview('material-purchase-prices', { bytes: csv([HEAD,
    [M.b, '', '', '', '0', '', '', '', '01/11/2026', ''],
    [M.b, '', '', '', '-12', '', '', '', '01/11/2026', ''],
    [M.b, '', '', '', '12.345', '', '', '', '01/11/2026', ''],
    [M.b, '', '', '', '80', '100.5', '140', '29', '01/11/2026', ''],
    [M.b, '', '', '', '80', '', '', '', '12/02/2027', ''],
    [M.b, '', '', '', '80', '', '', '', '', ''],
    [`NOPE-${run}`, '', '', 'Nobody Ltd', '80', '', '', '', '01/11/2026', ''],
    [M.d, '', '', '', '80', '', '', '', '01/11/2026', ''],
    [M.d, '', 'drum', '', '80', '', '', '', '01/11/2026', ''],
    [M.b, '', '', '', '80', '100', '', '', '05/11/2026', ''],
  ]) }, ctx());
  assert.match(rowOf(pre, 2).problems.join(' '), /price of zero is not a price\. Leave the cell empty for "no change"/);
  assert.match(rowOf(pre, 3).problems.join(' '), /is below zero/);
  assert.match(rowOf(pre, 4).problems.join(' '), /two decimals at most/);
  const r5 = rowOf(pre, 5).problems.join(' ');
  for (const re of [/discount of more than 100% is not a discount/, /GST rate of more than 100%/, /"29" is not an HSN code/]) assert.match(r5, re);
  assert.match(rowOf(pre, 6).problems.join(' '), /more than 90 days ahead/);
  assert.match(rowOf(pre, 7).problems.join(' '), /"Effective from" is empty: a price needs the day it starts/);
  assert.match(rowOf(pre, 8).problems.join(' '), /No material with the code NOPE-.*No supplier "Nobody Ltd" is on file/);
  assert.match(rowOf(pre, 9).problems.join(' '), /"Unit" is empty and the material has no unit on file/);
  assert.match(rowOf(pre, 10).problems.join(' '), /price cannot be per "drum"\. Give it per kg, g, L, ml or unit/);
  assert.equal(rowOf(pre, 11).outcome, 'create'); // a 100% discount is a discount: net zero, said so
  assert.match(rowOf(pre, 11).notes.join(' '), /Net Rs 0\.00 per g/);
});

test('the single price typed on screen goes through the same function: same judgement, same row, same fact', async () => {
  const before = (await facts()).length;
  const made = await prices.recordOne({ materialCode: M.c, listPrice: '4.25', discountPercent: '10', effectiveFrom: '2026-11-12', note: 'by phone' }, buyer, today);
  assert.equal(made.recorded, true);
  assert.equal((made as { netPrice: string }).netPrice, '3.83'); // 4.25 less 10% = 3.825 -> 3.83
  const sent = await facts();
  assert.equal(sent.length, before + 1);
  const f = sent.at(-1)!;
  assert.deepEqual([f.payload.material_code, f.payload.unit, f.payload.list_price_paise_per_unit, f.payload.purchase_discount_bps, f.payload.net_price_paise_per_unit, f.payload.source, f.payload.job_ref], [M.c, 'unit', 425, 1000, 383, 'screen', null]);
  assert.equal(f.aggregate_id, (made as { materialPurchasePriceId: string }).materialPurchasePriceId);
  // Again: nothing changes. A different figure for that date: refused in the sheet's own words. No fact for either.
  assert.equal((await prices.recordOne({ materialCode: M.c, listPrice: '4.25', discountPercent: '10', effectiveFrom: '12/11/2026' }, buyer, today)).recorded, false);
  await assert.rejects(() => prices.recordOne({ materialCode: M.c, listPrice: '5', effectiveFrom: '12/11/2026' }, buyer, today), /never rewritten: give a later effective date/);
  await assert.rejects(() => prices.recordOne({ materialCode: M.c, listPrice: '', effectiveFrom: '12/11/2026' }, buyer, today), /Give the list purchase price/);
  await assert.rejects(() => prices.recordOne({ materialCode: M.c, listPrice: '0', effectiveFrom: '13/11/2026' }, buyer, today), /price of zero is not a price/);
  assert.equal((await facts()).length, before + 1);
  const hist = await prices.history(M.c);
  assert.deepEqual((hist.items as Array<Record<string, unknown>>).map((h) => [h.materialCode, h.listPrice, h.netPrice, h.effectiveFrom, h.source]), [[M.c, '4.25', '3.83', '2026-11-12', 'screen']]);
});

test('through the signed bridge: the envelope ALEMBIC receives for one recorded price', async () => {
  assert.ok((OUTBOUND_TO_ALEMBIC as readonly string[]).includes(MATERIAL_COST_RECORDED));
  const [target] = await sql()`select o.id::text as id from bridge.outbox o where o.type = ${MATERIAL_COST_RECORDED} and o.payload->>'material_code' = ${M.a} and o.payload->>'effective_from' = '2026-11-01'`;
  const captured: Array<{ body: string; headers: Record<string, string> }> = [];
  (relay as unknown as { fetchImpl: unknown }).fetchImpl = async (_url: string, init: { body: string; headers: Record<string, string> }) => { captured.push({ body: init.body, headers: init.headers }); return new Response('{}', { status: 200 }); };
  for (let i = 0; i < 400 && !captured.some((c) => c.headers['x-bridge-event-id'] === target!.id); i++) await relay.drain();
  const hit = captured.find((c) => c.headers['x-bridge-event-id'] === target!.id);
  assert.ok(hit, 'the relay delivered the fact');
  assert.equal(verifyBody(hit.body, SECRET, hit.headers['x-bridge-signature']!), true, 'signed over the exact bytes');
  const env = JSON.parse(hit.body);
  assert.deepEqual(validateEnvelope(env, OUTBOUND_TO_ALEMBIC), { ok: true, envelope: validateEnvelope(env, OUTBOUND_TO_ALEMBIC).ok ? (validateEnvelope(env, OUTBOUND_TO_ALEMBIC) as { envelope: unknown }).envelope : null });
  assert.equal(env.org_id, TENANT);
  assert.deepEqual([env.event_id, env.version, env.type, env.source, env.aggregate.type], [target!.id, 1, 'material.cost.recorded', 'rawprod', 'material_cost']);
  assert.equal(env.payload.net_price_paise_per_unit, 118798);
  // Delivered once: a second pass does not send it again, and never under another id.
  const n = captured.filter((c) => c.headers['x-bridge-event-id'] === target!.id).length;
  await relay.drain();
  assert.equal(captured.filter((c) => c.headers['x-bridge-event-id'] === target!.id).length, n);
});
