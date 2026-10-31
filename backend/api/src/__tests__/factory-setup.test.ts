/**
 * FACTORY-SETUP (lane catalogue, owner decisions 2026-10-05) — the factory catalogue endpoint,
 * the setup checklist and Ruh's proposals with one-person approval. Real Postgres, real services
 * (no mocks but ALEMBIC's half, which is a fake fetch answering exactly what ALEMBIC answers).
 *
 *   signed: a body signed with the bridge secret over timestamp.nonce.body is applied; a bad
 *           signature, a stale timestamp and a replayed nonce are each refused 401 and write nothing;
 *           another tenant is refused 403.
 *   idempotent: sending the same item twice creates one material, one floor code, one product,
 *           one factory SKU; a third send with a new name updates only what the endpoint owns.
 *   honest: a CAS number without its source is refused; nothing recipe-shaped is accepted; a
 *           product made by hand under the same code is linked, never rewritten, and its formula
 *           link is never touched.
 *   approval: a QC draft becomes a spec only on approval, through CoaService, as the approver;
 *           a second decision is refused; a rack layout is built through the CSV import, with the
 *           approver's edited counts; the role gates are the existing permissions.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ensureSchema, testClient, bridgeDb, productionDb, principal, closeTestClient } from '../../../test-support/db.js';
import { sealSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';
import { CoaService } from '@ra/cluster-production';
import { shelfDb } from '../shelf/shelf.tokens.js';
import { ShelfLayoutService } from '../shelf/shelf-layout.service.js';
import { PickLightService } from '../shelf/pick-light.service.js';
import { FactoryCatalogueService, type ItemResult } from '../factory-setup/catalogue.service.js';
import { SetupStatusService } from '../factory-setup/setup-status.service.js';
import { FactorySetupService } from '../factory-setup/setup.service.js';
import { AlembicDraftsClient } from '../factory-setup/alembic-drafts.client.js';
import { FactorySetupController, CHECKLIST_PERMISSIONS } from '../factory-setup/factory-setup.controller.js';
import {
  floorCodeFor, itemProblems, requestProblems, planRackLayout, layoutCsv, layoutProblems, layoutBins, readQcDraft,
  decide, weakest, type CatalogueItem,
} from '../factory-setup/catalogue.contract.js';
import { ROLES as RA_ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';

const SECRET = 'factory-setup-test-secret';
const TENANT = '0190f0a1-0000-7000-8000-00000000c47a';
const kekPrior = process.env.BRIDGE_HMAC_KEK;

let catalogue: FactoryCatalogueService;
let status: SetupStatusService;
let setup: FactorySetupService;
let layout: ShelfLayoutService;
let lights: PickLightService;
let coa: CoaService;
const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let draftsReply: (codes: string[]) => unknown = () => ({ ok: true, ai: 'not_needed', items: [] });

async function seedConnector(): Promise<void> {
  await testClient()`
    insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed, configured_by)
    values ('default', true, 'https://alembic.example.test/api/v1/bridge/rawprod/events', ${sealSecret(SECRET)}, 'test')
    on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url, hmac_secret_sealed = excluded.hmac_secret_sealed`;
}

const fakeFetch = (async (url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  fetchCalls.push({ url, body });
  return new Response(JSON.stringify(draftsReply(body.skuCodes as string[])), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = Buffer.alloc(32, 7).toString('base64');
  await seedConnector();
  const sql = testClient();
  const db = shelfDb(sql);
  layout = new ShelfLayoutService(db);
  lights = new PickLightService(db);
  coa = new CoaService(productionDb());
  status = new SetupStatusService(sql);
  const config = { get: (k: string) => (k === 'ALEMBIC_ASSERTION_TENANT_ID' ? TENANT : undefined) } as never;
  catalogue = new FactoryCatalogueService(sql, bridgeDb(), config, lights, status);
  setup = new FactorySetupService(sql, coa, layout, new AlembicDraftsClient(bridgeDb(), config, fakeFetch));
});

after(async () => {
  await lights.onModuleDestroy?.();
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK; else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await closeTestClient();
});

function item(over: Partial<CatalogueItem> = {}): CatalogueItem {
  const id = randomUUID();
  return {
    alembic_sku_id: id, sku_code: `FS-${id.slice(0, 8).toUpperCase()}`, name: 'Hedione Test', category: 'molecule',
    classification: 'single_chemical', classification_basis: 'CAS number 24851-98-7 on file', grade: null,
    cas_number: '24851-98-7', cas_source: 'ALEMBIC catalogue (product record)', density_mg_per_ml: null, density_source: null,
    hazmat: { is_hazmat: false, un_number: null, hazard_class: null, packing_group: null, flash_point_c: null, source: null, verified_at: null },
    pack_sizes: [{ label: '100 g', dimension: 'MASS', kg: 0.1, status: 'ok' }, { label: '30 ml', dimension: 'VOLUME', kg: null, status: 'needs_density' }],
    on_hand_kg: 60, ...over,
  };
}

function signed(body: unknown, o: { ts?: number; nonce?: string; secret?: string; tamper?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(o.ts ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? randomUUID();
  const sig = signBody(`${timestamp}.${nonce}.${raw}`, o.secret ?? SECRET);
  return [o.tamper ? raw.replace('Test', 'Tost') : raw, sig, timestamp, nonce] as const;
}

const send = (body: unknown, o?: Parameters<typeof signed>[1]) => { const [r, s, t, n] = signed(body, o); return catalogue.handle(r, s, t, n); };
/** The per-item results of a 200 answer. */
const res = (r: { body: unknown }): ItemResult[] => (r.body as { results: ItemResult[] }).results;
const upsert = (items: CatalogueItem[], subject: string | null = null) => send({ tenantId: TENANT, subject, op: 'upsert', items });

/* ── the contract (pure) ─────────────────────────────────────────────────────────────── */

test('floor code: deterministic, opaque, base32 without look-alikes, lengthens on a clash', () => {
  assert.equal(floorCodeFor('ISO-E-SUPER'), floorCodeFor('iso-e-super '.trim()));
  assert.match(floorCodeFor('ISO-E-SUPER'), /^RM-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.ok(!floorCodeFor('ISO-E-SUPER').includes('ISO'));
  assert.notEqual(floorCodeFor('A'), floorCodeFor('B'));
  assert.equal(floorCodeFor('A', 1).length, floorCodeFor('A').length + 2);
});

test('item shape: a CAS number travels with its source, and nothing recipe-shaped is accepted', () => {
  assert.deepEqual(itemProblems(item()), []);
  assert.ok(itemProblems(item({ cas_source: null })).some((p) => p.startsWith('cas_source')));
  assert.ok(itemProblems({ ...item(), formula: { a: 1 } }).includes('unexpected:formula'));
  assert.ok(itemProblems({ ...item(), ingredients: [] }).includes('unexpected:ingredients'));
  assert.ok(itemProblems(item({ sku_code: 'X'.repeat(51) })).includes('sku_code'));
  assert.ok(itemProblems(item({ classification: 'mixture' as never })).includes('classification'));
  assert.deepEqual(requestProblems({ tenantId: TENANT, subject: null, op: 'upsert', items: [] }), ['items']);
  assert.deepEqual(requestProblems({ tenantId: TENANT, op: 'status', items: [] }), []);
});

test('rack plan: zones by family, one bin per product + one per 25 kg, racks of 5x4; CSV matches quick-rack codes', () => {
  const plan = planRackLayout([
    { classification: 'single_chemical', grade: null, onHandKg: 60 },  // 1 + 2 bins
    { classification: 'blend', grade: 'Klone', onHandKg: 0 },           // 1
    { classification: 'blend', grade: null, onHandKg: 10 },             // 1
  ]);
  assert.deepEqual(plan.zones.map((z) => z.zone), ['CHM', 'KLN', 'BLD']);
  assert.equal(plan.zones[0]!.racks, 1);
  const csv = layoutCsv({ zones: [{ ...plan.zones[0]!, racks: 2, shelvesPerRack: 2, binsPerShelf: 2 }], walkStart: 10 }).split('\n');
  assert.equal(csv[0], 'zone,rack,shelf,bin,walk');
  assert.equal(csv[1], 'CHM,CHM01,S1,B1,10');
  assert.equal(csv.at(-1), 'CHM,CHM02,S2,B2,20');
  assert.equal(layoutBins({ zones: [{ ...plan.zones[0]!, racks: 2, shelvesPerRack: 2, binsPerShelf: 2 }], walkStart: 10 }), 8);
  assert.deepEqual(layoutProblems({ zones: [{ zone: 'chm', racks: 1, shelvesPerRack: 1, binsPerShelf: 1 }] }), ['zones[0].zone']);
  assert.ok(layoutProblems({ zones: [{ zone: 'CHM', racks: 0, shelvesPerRack: 1, binsPerShelf: 1 }] }).includes('a layout needs at least one rack'));
});

test('proposal lifecycle: decided once; the weakest source names the row; a draft with a crossed range is unusable', () => {
  assert.deepEqual(decide('proposed', 'approve'), { ok: true, next: 'approved' });
  assert.equal(decide('approved', 'reject').ok, false);
  assert.equal(decide('rejected', 'approve').ok, false);
  assert.equal(weakest(['document', 'catalogue fact']), 'catalogue fact');
  assert.equal(weakest(['document', 'estimate', 'document']), 'estimate');
  const f = (value: number, source = 'document') => ({ value, source, evidence: 'coa.pdf' });
  assert.equal(readQcDraft({ sg_min: f(0.97), sg_max: f(0.95), flash_point_min_c: f(90), flash_point_max_c: f(96), shelf_life_months: f(24) }), null);
  assert.ok(readQcDraft({ sg_min: f(0.95), sg_max: f(0.97), flash_point_min_c: f(90), flash_point_max_c: f(96), shelf_life_months: f(24) }));
  assert.equal(readQcDraft({ sg_min: f(0.95, 'guess'), sg_max: f(0.97), flash_point_min_c: f(90), flash_point_max_c: f(96), shelf_life_months: f(24) }), null);
});

/* ── the signed endpoint ─────────────────────────────────────────────────────────────── */

test('signed: a bad signature, a stale timestamp and a replayed nonce are refused and write nothing', async () => {
  const it = item();
  const body = { tenantId: TENANT, subject: null, op: 'upsert', items: [it] };
  assert.equal((await send(body, { secret: 'not-the-secret' })).status, 401);
  assert.equal((await send(body, { tamper: true })).status, 401);
  assert.equal((await send(body, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  const nonce = randomUUID();
  assert.equal((await send(body, { nonce })).status, 200);
  assert.equal((await send(body, { nonce })).status, 401, 'the same nonce twice is a replay');
  const rows = await testClient()`select count(*)::int as n from bridge.catalogue_item where alembic_sku_id = ${it.alembic_sku_id}`;
  assert.equal(rows[0]!.n, 1);
});

test('tenant-scoped: a validly signed call for another ALEMBIC tenant is refused 403', async () => {
  const r = await send({ tenantId: randomUUID(), subject: null, op: 'upsert', items: [item()] });
  assert.equal(r.status, 403);
});

test('upsert: material + floor code + product (no formula) + factory SKU == the ALEMBIC code; idempotent', async () => {
  const sql = testClient();
  const it = item();
  const first = await upsert([it]);
  assert.equal(first.status, 200);
  const r = res(first)[0]!;
  assert.equal(r.outcome, 'created');
  assert.equal(r.floor_code, floorCodeFor(it.sku_code));
  const [sku] = await sql`select s.sku_code, s.pack_size, p.formula_id, p.product_code from packaging.product_sku s join packaging.product_master p on p.product_id = s.product_id where s.product_sku_id = ${r.product_sku_id}`;
  assert.equal(sku!.sku_code, it.sku_code);
  assert.equal(sku!.formula_id, null, 'no formula is linked here — that is the Vault lane');
  assert.equal(sku!.pack_size, null);
  const [mat] = await sql`select material_code, cas_number from masterdata.material where material_id = ${r.material_id}`;
  assert.equal(mat!.material_code, it.sku_code);
  assert.equal(mat!.cas_number, '24851-98-7');
  const events = await sql`select type from masterdata.outbox where aggregate_id in (${r.material_id}, ${r.rm_alias_id}) order by type`;
  assert.deepEqual(events.map((e) => e.type), ['masterdata.alias.created', 'masterdata.material.created']);

  const again = await upsert([it]);
  assert.equal(res(again)[0]!.outcome, 'unchanged');
  for (const [table, col] of [['masterdata.material', 'material_code'], ['packaging.product_master', 'product_code'], ['packaging.product_sku', 'sku_code']] as const) {
    const n = await sql`select count(*)::int as n from ${sql.unsafe(table)} where ${sql.unsafe(col)} = ${it.sku_code}`;
    assert.equal(n[0]!.n, 1, `${table} has one row`);
  }
  assert.equal((await sql`select count(*)::int as n from masterdata.rm_alias where material_id = ${r.material_id}`)[0]!.n, 1);

  const renamed = await upsert([{ ...it, name: 'Hedione Renamed', cas_number: null, cas_source: null }]);
  assert.equal(res(renamed)[0]!.outcome, 'updated');
  const [mat2] = await sql`select material_name, cas_number from masterdata.material where material_id = ${r.material_id}`;
  assert.equal(mat2!.material_name, 'Hedione Renamed');
  assert.equal(mat2!.cas_number, null, 'a CAS number ALEMBIC no longer holds is not kept on a material the bridge made');
  const audit = await sql`select after from bridge.audit_events where action = 'bridge.catalogue_synced' order by occurred_at desc limit 1`;
  assert.equal((audit[0]!.after as { items: number }).items, 1);
});

test('a product made by hand under the same code is linked, never rewritten, and its formula link stays', async () => {
  const sql = testClient();
  const it = item({ classification: 'blend', classification_basis: 'fragrance grade Klone', grade: 'Klone', cas_number: null, cas_source: null });
  const productId = randomUUID(); const skuId = randomUUID(); const formulaId = randomUUID();
  await sql`insert into packaging.product_master (product_id, formula_id, product_code, product_name, status) values (${productId}, ${formulaId}, ${it.sku_code}, 'Hand made', 'ACTIVE')`;
  await sql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status) values (${skuId}, ${productId}, ${it.sku_code}, '25 kg', 'ACTIVE')`;
  const r = res(await upsert([it]))[0]!;
  assert.equal(r.outcome, 'linked');
  assert.equal(r.product_id, productId);
  assert.equal(r.product_sku_id, skuId);
  const [p] = await sql`select formula_id::text, product_name from packaging.product_master where product_id = ${productId}`;
  assert.equal(p!.formula_id, formulaId);
  assert.equal(p!.product_name, 'Hand made');
});

test('a factory code already held by another ALEMBIC product is refused for that item only', async () => {
  const a = item();
  await upsert([a]);
  const b = item({ sku_code: a.sku_code });
  const c = item();
  const out = res(await upsert([b, c]));
  assert.equal(out[0]!.outcome, 'refused');
  assert.equal(out[1]!.outcome, 'created');
});

test('pick-to-light: the setup default is the on-screen simulator when unset, and a chosen mode is never changed', async () => {
  const sql = testClient();
  const prior = await sql`select mode, controller_url, hmac_secret_sealed from location.pick_light_config where id = 'default'`;
  await sql`delete from location.pick_light_config where id = 'default'`;
  await upsert([item()]);
  assert.equal((await sql`select mode from location.pick_light_config where id = 'default'`)[0]!.mode, 'simulator');
  await sql`update location.pick_light_config set mode = 'off' where id = 'default'`;
  await upsert([item()]);
  assert.equal((await sql`select mode from location.pick_light_config where id = 'default'`)[0]!.mode, 'off');
  if (prior[0]) await sql`update location.pick_light_config set mode = ${prior[0].mode}, controller_url = ${prior[0].controller_url}, hmac_secret_sealed = ${prior[0].hmac_secret_sealed} where id = 'default'`;
});

test('status: the checklist counts move with the catalogue', async () => {
  const before = await status.counts();
  await upsert([item(), item({ classification: 'blend', classification_basis: 'fragrance grade Klone', grade: 'Klone', cas_number: null, cas_source: null })]);
  const after = await status.counts();
  assert.equal(after.catalogue.products, before.catalogue.products + 2);
  assert.equal(after.catalogue.blends, before.catalogue.blends + 1);
  assert.equal(after.packs.needsDensity, before.packs.needsDensity + 2);
  assert.equal(after.qcSpecs.missing, before.qcSpecs.missing + 2);
  const viaBridge = await send({ tenantId: TENANT, subject: null, op: 'status', items: [] });
  assert.equal(viaBridge.status, 200);
  assert.equal(((viaBridge.body as { status: { catalogue: { products: number } } }).status).catalogue.products, after.catalogue.products);
});

/* ── proposals and approval ──────────────────────────────────────────────────────────── */

const field = (value: number | string, source: string, evidence: string) => ({ value, source, evidence });

test('QC drafts: asked of ALEMBIC (signed), stored as proposals, never a spec until a person approves', async () => {
  const sql = testClient();
  // Every product already in the shared test DB gets a spec-less draft too; answer for all of them.
  const it = item();
  const r = res(await upsert([it]))[0]!;
  draftsReply = (codes) => ({
    ok: true, ai: 'used',
    items: codes.map((c) => ({
      sku_code: c, source: 'estimate', missing: [], reason: null,
      draft: {
        sg_min: field(0.95, 'document', 'lab COA "x.pdf"'), sg_max: field(0.97, 'document', 'lab COA "x.pdf"'),
        flash_point_min_c: field(90, 'estimate', 'estimate: typical'), flash_point_max_c: field(96, 'estimate', 'estimate: typical'),
        shelf_life_months: field(24, 'document', 'lab COA "x.pdf"'), odour: field('Floral', 'estimate', 'estimate: typical'),
      },
    })),
  });
  fetchCalls.length = 0;
  const qc = principal({ userId: randomUUID(), roles: ['qc'], permissions: ['production:product_qc_spec:write', 'production:product_qc_spec:read'] });
  const out = await setup.draftQc(qc, 50);
  assert.ok(out.drafted >= 1);
  const call = fetchCalls[0]!;
  assert.equal(call.url, 'https://alembic.example.test/api/v1/internal/rawprod/factory-setup/qc-drafts');
  assert.equal(call.body.tenantId, TENANT);
  assert.ok((call.body.skuCodes as string[]).includes(it.sku_code));
  assert.ok(!JSON.stringify(call.body).match(/formula|recipe|ingredient/i), 'only SKU codes cross');

  const [prop] = await sql`select setup_proposal_id::text as id, source, status from production.setup_proposal where kind = 'qc_spec' and product_id = ${r.product_id}`;
  assert.equal(prop!.status, 'proposed');
  assert.equal(prop!.source, 'estimate', 'one estimated field makes the whole draft an estimate');
  assert.equal(await coa.getSpec(r.product_id!), null, 'no spec exists while the draft waits');

  const again = await setup.draftQc(qc, 50);
  assert.equal((await sql`select count(*)::int as n from production.setup_proposal where kind = 'qc_spec' and product_id = ${r.product_id} and status = 'proposed'`)[0]!.n, 1, 'asking again never stacks drafts');
  void again;

  const decided = await setup.decideQc([prop!.id], 'approve', null, qc);
  assert.equal(decided.approved, 1);
  const spec = await coa.getSpec(r.product_id!);
  assert.equal(Number(spec!.sgMin), 0.95);
  assert.equal(spec!.createdBy, qc.userId, 'written through CoaService as the approving person');
  assert.equal(spec!.odourStandard, 'Floral');
  const second = await setup.decideQc([prop!.id], 'reject', null, qc);
  assert.equal(second.refused[0]!.reason, 'this proposal is already approved');
  const audit = await sql`select actor_id::text from bridge.audit_events where action = 'factory_setup.qc_approved' and entity_id = ${prop!.id}`;
  assert.equal(audit[0]!.actor_id, qc.userId);
  // Clean up the drafts this test made for other products in the shared DB.
  await sql`update production.setup_proposal set status = 'superseded' where kind = 'qc_spec' and status = 'proposed'`;
});

test('QC drafts: ALEMBIC unreachable or not connected drafts nothing and says why', async () => {
  const qc = principal({ userId: randomUUID(), roles: ['qc'], permissions: ['production:product_qc_spec:write'] });
  await upsert([item()]);
  await testClient()`update bridge.connector_config set webhook_url = null where id = 'default'`;
  const out = await setup.draftQc(qc, 5);
  assert.equal(out.drafted, 0);
  assert.match(String(out.message), /not connected to the sales system/);
  await seedConnector();
});

test('a rejected QC draft writes no spec; a spec entered meanwhile is never overwritten by a draft', async () => {
  const sql = testClient();
  const qc = principal({ userId: randomUUID(), roles: ['qc'], permissions: ['production:product_qc_spec:write'] });
  const a = res(await upsert([item()]))[0]!;
  const b = res(await upsert([item()]))[0]!;
  const draft = { sg_min: field(0.9, 'estimate', 'e'), sg_max: field(0.92, 'estimate', 'e'), flash_point_min_c: field(70, 'estimate', 'e'), flash_point_max_c: field(80, 'estimate', 'e'), shelf_life_months: field(12, 'estimate', 'e') };
  const ids: string[] = [];
  for (const p of [a, b]) {
    const [row] = await sql`insert into production.setup_proposal (kind, product_id, subject_label, payload, source, evidence) values ('qc_spec', ${p.product_id}, 'x', ${JSON.stringify(draft)}::text::jsonb, 'estimate', 'e') returning setup_proposal_id::text as id`;
    ids.push(row!.id as string);
  }
  await setup.decideQc([ids[0]!], 'reject', 'not ours', qc);
  assert.equal(await coa.getSpec(a.product_id!), null);
  await coa.upsertSpec(b.product_id!, { sgMin: 1.0, sgMax: 1.02, flashPointMinC: 100, flashPointMaxC: 110, shelfLifeMonths: 36 }, qc);
  const decided = await setup.decideQc([ids[1]!], 'approve', null, qc);
  assert.equal(decided.approved, 0);
  assert.match(decided.refused[0]!.reason, /already has a QC spec/);
  assert.equal(Number((await coa.getSpec(b.product_id!))!.sgMin), 1.0);
});

test('racks: drafted from the catalogue as an estimate; acceptance builds the edited counts through the CSV import', async () => {
  const sql = testClient();
  await sql`update production.setup_proposal set status = 'superseded' where kind = 'rack_layout' and status = 'proposed'`;
  await upsert([item()]);
  const wh = principal({ userId: randomUUID(), roles: ['warehouse'], permissions: ['location:rack_master:write', 'location:shelf_master:write', 'location:bin_master:write'] });
  const d = await setup.draftRacks(wh);
  assert.ok(d.proposalId);
  const [p] = await sql`select source, payload, evidence from production.setup_proposal where setup_proposal_id = ${d.proposalId}`;
  assert.equal(p!.source, 'estimate');
  assert.match(String(p!.evidence), /one bin per product/);
  const zone = `Z${randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
  const edited = { zones: [{ zone, label: 'Test zone', products: 1, onHandKg: 0, racks: 2, shelvesPerRack: 2, binsPerShelf: 3 }], walkStart: 500 };
  const out = await setup.decideRacks(d.proposalId!, 'approve', edited, null, wh);
  assert.equal(out.status, 'approved');
  assert.equal((out.applied as { created: number }).created, 12);
  const bins = await sql`select bin_code from location.bin_master where bin_code like ${`${zone}%`} order by bin_code`;
  assert.equal(bins.length, 12);
  assert.equal(bins[0]!.bin_code, `${zone}01-S1-B1`);
  await assert.rejects(setup.decideRacks(d.proposalId!, 'approve', null, null, wh), /already approved/);
});

test('role gates: QC decisions need the QC spec write (qc, owner); racks need rack+shelf+bin write (warehouse, owner)', () => {
  const reflector = new Reflector();
  const perms = (m: keyof FactorySetupController) =>
    reflector.get<string[]>('core:permissions', FactorySetupController.prototype[m] as never) ?? [];
  assert.deepEqual(perms('decideQc'), ['production:product_qc_spec:write']);
  assert.deepEqual(perms('draftQc'), ['production:product_qc_spec:write']);
  assert.deepEqual(perms('decideRacks'), ['location:rack_master:write', 'location:shelf_master:write', 'location:bin_master:write']);
  const holders = (needed: string[]) => RA_ROLES.filter((r) => needed.every((p) => RA_PERMISSIONS.includes(p as never) && r.select(p))).map((r) => r.code).sort();
  assert.deepEqual(holders(perms('decideQc')), ['owner', 'qc']);
  assert.deepEqual(holders(perms('decideRacks')), ['owner', 'warehouse']);
  for (const p of CHECKLIST_PERMISSIONS) assert.ok(RA_PERMISSIONS.includes(p as never), p);
});
