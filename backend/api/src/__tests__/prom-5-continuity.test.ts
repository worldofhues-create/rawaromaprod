/**
 * PROM-5 (LD-85, ALEMBIC docs/plan/program/process-promises.md P-04, P-05, P-08): what "the same oil" means,
 * and detecting a change. Real Postgres; the real oil-batch create (which records continuity at compounding)
 * and the kernel recorder the reference approval calls.
 *
 *   - the key is a pure function of formula version, identities with suppliers, and the reference:
 *     stable across runs, blind to lot order, and opaque (no name, CAS or supplier in it or its events);
 *   - a product's first keyed batch sets its continuity and raises no change;
 *   - a new lot from the SAME supplier is not a change; a supplier swap is one (`supplier`), unless
 *     `continuity.supplier_change_is_material` is off; a new formula version is one (`formula_version`);
 *   - a raw lot with no supplier on file gives no key, says why, and raises nothing (Rule 3);
 *   - a product's first reference is not a change; replacing it is one (`reference`);
 *   - both facts pass RawProd's checks and ALEMBIC's own parsers (verbatim copy), and the shared fixtures
 *     parse on both sides.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import 'reflect-metadata';
import { BatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { parseProductContinuityCurrent, parseProductMaterialChanged } from '../../../test-support/alembic-prom.js';
import { PolicyService, POLICY_KEYS } from '../policy/policy.service.js';
import { drizzleExec } from '../floor-ops/floor-util.js';
import { continuityKey, changeKinds, recordReferenceContinuity, FACTORY_ENFORCEMENT_VERSION, FACTORY_RULE_DEFAULTS } from '@core/backend-kernel';
import { bridge } from '@core/contracts';
import type { Sql } from 'postgres';

let batches: BatchService, policy: PolicyService;
const op = principal();
const editor = () => principal({ userId: randomUUID(), roles: ['admin'], permissions: ['platform:policy:write'], authTime: Math.floor(Date.now() / 1000) } as never);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../test-support/fixtures/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>;

before(async () => {
  await ensureSchema();
  batches = new BatchService(productionDb());
  policy = new PolicyService(testClient());
});
after(async () => closeTestClient());

const s = () => testClient();
/** A product (one code and grade) on its own formula. */
async function product() {
  const productId = randomUUID(), formulaId = randomUUID(), code = 'P5-' + productId.slice(0, 6).toUpperCase();
  await s()`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status) values (${productId}, ${code}, 'Oud Rose Vetiver', ${formulaId}, 'ACTIVE')`;
  return { productId, formulaId, code };
}
/** A material identity: the name and CAS are test data that must never cross. */
async function material(name: string) {
  const id = randomUUID();
  await s()`insert into masterdata.material (material_id, material_code, material_name) values (${id}, ${'M5-' + id.slice(0, 6)}, ${name + ' CAS 119-61-9'})`;
  return id;
}
async function vendor(name: string) {
  const id = randomUUID();
  await s()`insert into procurement.vendor_details (vendor_id, vendor_name) values (${id}, ${name})`;
  return id;
}
/** A raw lot of `materialId` received from `vendorId` (null: no goods receipt on file). Returns the inventory batch. */
async function rawLot(materialId: string, vendorId: string | null) {
  const rb = randomUUID(), ib = randomUUID();
  let grnItem: string | null = null;
  if (vendorId) {
    const grn = randomUUID(); grnItem = randomUUID();
    await s()`insert into inventory.grn_master (grn_id, grn_number, vendor_id, status) values (${grn}, ${'GRN-' + grn.slice(0, 6)}, ${vendorId}, 'ACTIVE')`;
    await s()`insert into inventory.grn_items (grn_item_id, grn_id, material_id, received_qty) values (${grnItem}, ${grn}, ${materialId}, 100)`;
  }
  await s()`insert into inventory.rm_batch_master (rm_batch_id, grn_item_id, material_id, batch_number, status) values (${rb}, ${grnItem}, ${materialId}, ${'RM-' + rb.slice(0, 6)}, 'ACTIVE')`;
  await s()`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, status) values (${ib}, ${rb}, ${materialId}, 100, 'ACTIVE')`;
  return ib;
}
/** An oil batch of the product under `formulaVersionId`, consuming `lots`. */
async function compound(p: { formulaId: string }, formulaVersionId: string | null, lots: string[]) {
  const planItem = randomUUID(), order = randomUUID();
  await s()`insert into production.production_plan_items (production_plan_item_id, formula_id, planned_qty, status) values (${planItem}, ${p.formulaId}, 10, 'ACTIVE')`;
  await s()`insert into production.production_order (production_order_id, production_plan_item_id, formula_version_id, order_qty, status) values (${order}, ${planItem}, ${formulaVersionId}, 10, 'ACTIVE')`;
  const { batch } = await batches.produceOilBatch({ productionOrderId: order, producedQty: 10, consumption: lots.map((l) => ({ consumedForDocumentId: l, consumedQty: 1 })) }, op);
  const [row] = await s()`select continuity_key, missing from production.batch_continuity where oil_batch_id = ${batch.oilBatchId}`;
  return { id: String(batch.oilBatchId), no: String(batch.batchNumber), key: (row?.continuity_key as string | null) ?? null, missing: (row?.missing as string[] | null) ?? null };
}
const facts = async (code: string) => (await s()`select type, payload from bridge.outbox where payload->>'product_code' = ${code} order by seq`) as unknown as Array<{ type: string; payload: Record<string, unknown> }>;
const changes = async (productId: string) => (await s()`select kind, from_key, to_key, first_batch_no from production.material_change where product_id = ${productId} order by created_dt`) as unknown as Array<{ kind: string; from_key: string; to_key: string; first_batch_no: string | null }>;

test('the key is a pure function: stable, blind to lot order and duplicates, opaque', () => {
  const a = { formulaVersionRef: 'fv-1', referenceRef: 'R-1', supplierIsMaterial: true, lots: [{ identityRef: 'm1', supplierRef: 's1' }, { identityRef: 'm2', supplierRef: 's2' }] };
  const b = { ...a, lots: [a.lots[1]!, a.lots[0]!, a.lots[0]!] };
  const ka = continuityKey(a), kb = continuityKey(b);
  assert.ok(ka.ok && kb.ok);
  assert.equal(ka.key, kb.key);
  assert.match(ka.key, /^ck1:[0-9a-f]{64}$/);
  const again = continuityKey(a);
  assert.equal(again.ok && again.key, ka.key, 'the same inputs give the same key every run');
  const swap = continuityKey({ ...a, lots: [{ identityRef: 'm1', supplierRef: 's9' }, a.lots[1]!] });
  assert.ok(swap.ok && swap.key !== ka.key);
  assert.deepEqual(changeKinds(ka.components, swap.ok ? swap.components : ka.components), ['supplier']);
  const off = continuityKey({ ...a, supplierIsMaterial: false }), offSwap = continuityKey({ ...a, supplierIsMaterial: false, lots: [{ identityRef: 'm1', supplierRef: 's9' }, a.lots[1]!] });
  assert.ok(off.ok && offSwap.ok && off.key === offSwap.key, 'with the supplier rule off a supplier swap is the same oil');
  const v2 = continuityKey({ ...a, formulaVersionRef: 'fv-2' });
  assert.deepEqual(changeKinds(ka.components, v2.ok ? v2.components : ka.components), ['formula_version']);
  const r2 = continuityKey({ ...a, referenceRef: 'R-2' });
  assert.deepEqual(changeKinds(ka.components, r2.ok ? r2.components : ka.components), ['reference']);
  const first = continuityKey({ ...a, referenceRef: null });
  assert.deepEqual(changeKinds(first.ok ? first.components : ka.components, ka.components), [], "a product's first reference is not a change");
  const none = continuityKey({ ...a, formulaVersionRef: null, lots: [{ identityRef: 'm1', supplierRef: null }] });
  assert.ok(!none.ok);
  assert.equal(none.missing.length, 2, 'no formula version, and a lot with no supplier: both said, no key');
  for (const leak of ['m1', 's1', 'fv-1', 'R-1']) assert.ok(!ka.key.includes(leak));
});

test('compounding: first batch sets continuity; same supplier new lot is no change; a supplier swap is one, sent before release', async () => {
  const p = await product();
  const fv = randomUUID();
  const rose = await material('Rose absolute'), vetiver = await material('Vetiver oil');
  const acme = await vendor('Acme Aromatics Pvt Ltd'), other = await vendor('Other Oils LLP');

  const b1 = await compound(p, fv, [await rawLot(rose, acme), await rawLot(vetiver, acme)]);
  assert.match(String(b1.key), /^ck1:[0-9a-f]{64}$/);
  let f = await facts(p.code);
  assert.deepEqual(f.map((x) => x.type), ['product.continuity.current'], 'first keyed batch: its continuity, no change');
  assert.equal(f[0]!.payload.first_batch_no, b1.no);
  assert.equal((await changes(p.productId)).length, 0);

  const b2 = await compound(p, fv, [await rawLot(vetiver, acme), await rawLot(rose, acme)]);
  assert.equal(b2.key, b1.key, 'new lots from the same suppliers: the same oil');
  assert.equal((await facts(p.code)).length, 1, 'nothing sent');

  const b3 = await compound(p, fv, [await rawLot(rose, other), await rawLot(vetiver, acme)]);
  assert.notEqual(b3.key, b1.key);
  const ch = await changes(p.productId);
  assert.deepEqual(ch.map((c) => [c.kind, c.from_key, c.to_key, c.first_batch_no]), [['supplier', b1.key, b3.key, b3.no]]);
  f = await facts(p.code);
  assert.deepEqual(f.map((x) => x.type), ['product.continuity.current', 'product.material.changed', 'product.continuity.current']);
  const changed = f[1]!.payload;
  assert.deepEqual(bridge.checkProductMaterialChangedWire(changed as never), []);
  const parsed = parseProductMaterialChanged(changed);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.record.kind, 'supplier');
  assert.equal(parsed.record.firstBatchNo, b3.no);
  const current = parseProductContinuityCurrent(f[2]!.payload);
  assert.ok(current.ok && current.record.continuityKey === b3.key);
  // D-1: no material name, CAS number, supplier, formula id or person in any fact.
  const wire = JSON.stringify(f.map((x) => x.payload));
  for (const banned of [/Rose|Vetiver|Oud/i, /119-61-9|CAS/, /Acme|Other Oils/, new RegExp(fv), new RegExp(p.formulaId), new RegExp(op.userId), new RegExp(rose), new RegExp(acme)]) {
    assert.doesNotMatch(wire, banned);
  }
  for (const x of f) assert.doesNotThrow(() => bridge.assertNoFormulaContent(x.payload));
  // Recorded at compounding: the batch has not rested or been released, so no lot under the new key is on sale yet.
  const [st] = await s()`select status from production.oil_batch_master where oil_batch_id = ${b3.id}`;
  assert.equal(st!.status, 'ACTIVE');
});

test('a new formula version is a change; with the supplier rule off a supplier swap is not', async () => {
  const p = await product();
  const fv1 = randomUUID(), fv2 = randomUUID();
  const m = await material('Ambergris accord'), a = await vendor('Vendor A'), b = await vendor('Vendor B');
  const b1 = await compound(p, fv1, [await rawLot(m, a)]);
  const b2 = await compound(p, fv2, [await rawLot(m, a)]);
  assert.deepEqual((await changes(p.productId)).map((c) => [c.kind, c.to_key]), [['formula_version', b2.key]]);
  assert.notEqual(b1.key, b2.key);

  await policy.publish('continuity.supplier_change_is_material', { rules: [], hasDefault: true, defaultValue: { isMaterial: false } }, 'test: supplier swaps are not material for this case', editor());
  try {
    const off1 = await compound(p, fv2, [await rawLot(m, a)]);
    const off2 = await compound(p, fv2, [await rawLot(m, b)]);
    assert.equal(off1.key, off2.key, 'rule off: the same oil from another supplier');
    assert.equal((await changes(p.productId)).filter((c) => c.kind === 'supplier').length, 0);
  } finally {
    await policy.publish('continuity.supplier_change_is_material', { rules: [], hasDefault: true, defaultValue: { isMaterial: true } }, 'test: back to the shipped default', editor());
  }
});

test('Rule 3: a raw lot with no supplier on file, or no formula version, gives no key, says why, and sends nothing', async () => {
  const p = await product();
  const m = await material('Labdanum resin');
  const noSupplier = await compound(p, randomUUID(), [await rawLot(m, null)]);
  assert.equal(noSupplier.key, null);
  assert.ok(noSupplier.missing!.some((x) => /supplier/.test(x)), JSON.stringify(noSupplier.missing));
  const noVersion = await compound(p, null, [await rawLot(m, await vendor('V'))]);
  assert.equal(noVersion.key, null);
  assert.ok(noVersion.missing!.includes('formula_version'));
  const offFloor = await compound(p, randomUUID(), []);
  assert.ok(offFloor.missing!.includes('raw_lots'), 'a batch with no consumption on record proves nothing');
  assert.equal((await facts(p.code)).length, 0);
  assert.equal((await changes(p.productId)).length, 0);
});

test("a product's first reference moves its continuity without a change; replacing the reference is a change", async () => {
  const p = await product();
  const m = await material('Iso E Super'), v = await vendor('V1');
  const b1 = await compound(p, randomUUID(), [await rawLot(m, v)]);
  const run = (referenceCode: string, replacesRef: string | null) => testClient().begin((tx) =>
    recordReferenceContinuity(drizzleExec(tx as unknown as Sql), { productId: p.productId, referenceCode, replacesRef, recordedBy: op.userId }));
  const first = await run('R-' + p.code + '-1', null);
  assert.equal(first.changed, false);
  assert.notEqual(first.key, b1.key);
  assert.equal((await changes(p.productId)).length, 0, 'the first reference: its earlier batches compared with nothing');
  const second = await run('R-' + p.code + '-2', 'R-' + p.code + '-1');
  assert.equal(second.changed, true);
  const ch = await changes(p.productId);
  assert.deepEqual(ch.map((c) => [c.kind, c.from_key, c.to_key, c.first_batch_no]), [['reference', first.key, second.key, null]]);
  const f = await facts(p.code);
  assert.deepEqual(f.map((x) => x.type), ['product.continuity.current', 'product.continuity.current', 'product.material.changed', 'product.continuity.current']);
  for (const x of f) {
    const parsed = x.type === 'product.material.changed' ? parseProductMaterialChanged(x.payload) : parseProductContinuityCurrent(x.payload);
    assert.ok(parsed.ok, JSON.stringify(parsed));
  }
});

test('the reference approval records continuity in its own transaction', () => {
  const src = readFileSync(new URL('../prodfloor/reference-standard.service.ts', import.meta.url), 'utf8');
  assert.match(src, /recordReferenceContinuity\(drizzleExec\(tx as unknown as Sql\)/);
});

test('continuity.supplier_change_is_material is data: default true, both values valid, no record override, enforcement v1', async () => {
  assert.ok((POLICY_KEYS as readonly string[]).includes('continuity.supplier_change_is_material'));
  assert.deepEqual(FACTORY_RULE_DEFAULTS['continuity.supplier_change_is_material'], { isMaterial: true });
  assert.equal(FACTORY_ENFORCEMENT_VERSION['continuity.supplier_change_is_material'], 1);
  await assert.rejects(() => policy.publish('continuity.supplier_change_is_material', { rules: [], hasDefault: true, defaultValue: { isMaterial: 'yes' } }, 'bad shape', editor()), /isMaterial must be true or false/);
  await assert.rejects(() => policy.override('continuity.supplier_change_is_material', 'oil_batch', randomUUID(), { isMaterial: false }, 'one batch', principal({ roles: ['admin'] })), /no single-record override/);
});

test('the shared fixtures pass RawProd checks and parse with ALEMBIC\'s parsers; malformed shapes are refused on both sides', () => {
  const cur = fixture('product-continuity-current.json'), ch = fixture('product-material-changed.json');
  assert.deepEqual(bridge.checkProductContinuityCurrentWire(cur as never), []);
  assert.deepEqual(bridge.checkProductMaterialChangedWire(ch as never), []);
  assert.ok(parseProductContinuityCurrent(cur).ok);
  assert.ok(parseProductMaterialChanged(ch).ok);
  for (const bad of [{ kind: 'colour' }, { to_key: ch.from_key }, { from_key: 'sha256:abc' }, { supplier: 'Acme' }, { approved_at: 'today' }]) {
    const x = { ...ch, ...bad };
    assert.notDeepEqual(bridge.checkProductMaterialChangedWire(x as never), [], JSON.stringify(bad));
    assert.equal(parseProductMaterialChanged(x).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseProductContinuityCurrent({ ...cur, materials: ['m1'] }).ok, false, 'a materials key is formula content');
});
