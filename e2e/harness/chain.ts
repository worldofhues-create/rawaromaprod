/* What a walk needs to exist before its own step: the state earlier flows would have left, made through
 * the same HTTP API the consoles' tunnel reaches, by the role that holds the permission (segregation of
 * duties included). Modelled on the golden story's acts J-M. The screen under test is still driven by
 * hand in the spec; this only gets the factory to the point where that screen has work to show.
 *
 * Stages are memoised in e2e/.run/chain.json, so a spec run alone builds what it needs and a whole run
 * builds each stage once. `pnpm e2e:up` wipes the file with the databases it describes. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { PORTS, RUN } from './config.mjs';
import { EMAIL, mintAssertion, type ConsoleName } from './walk';

const tokens = new Map<string, string>();
const API = `http://127.0.0.1:${PORTS.api}`;
const VAULT = `http://127.0.0.1:${PORTS.vaultApi}`;

async function tokenFor(role: string, target: ConsoleName) {
  const k = `${role}|${target}`;
  if (tokens.has(k)) return tokens.get(k)!;
  const res = await fetch(`${API}/auth/alembic-assertion`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: mintAssertion(EMAIL[role]!, target) }) });
  const j: any = await res.json();
  if (!j?.data?.accessToken) throw new Error(`sign-in for ${role} failed: ${res.status} ${JSON.stringify(j?.error)}`);
  tokens.set(k, j.data.accessToken);
  return j.data.accessToken as string;
}

export async function rp(role: string, method: string, path: string, body?: unknown, opts: { vault?: boolean } = {}) {
  const res = await fetch(`${opts.vault ? VAULT : API}${path}`, { method,
    headers: { authorization: `Bearer ${await tokenFor(role, opts.vault ? 'vault' : 'factory')}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let j: any = {}; try { j = JSON.parse(text); } catch { j = { data: text }; }
  return { status: res.status, body: j.data, error: j.error };
}
/** A precondition that fails stops the walk loudly: it must never read as the flow passing. */
export async function must(role: string, method: string, path: string, body?: unknown, opts: { vault?: boolean } = {}) {
  const r = await rp(role, method, path, body, opts);
  if (r.status >= 300) throw new Error(`chain: ${role} ${method} ${path} -> ${r.status} ${JSON.stringify(r.error)}`);
  return r.body;
}
export async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`chain: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
const find = async (role: string, path: string, hit: (r: any) => boolean) => ((await must(role, 'GET', `${path}${path.includes('?') ? '&' : '?'}limit=100`)) as any[]).find(hit);

const FILE = join(RUN, 'chain.json');
type S = Record<string, any>;
const load = (): S => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {});
const save = (s: S) => writeFileSync(FILE, JSON.stringify(s, null, 1), { mode: 0o600 });
async function stage(name: string, build: (s: S) => Promise<S>): Promise<S> {
  const s = load();
  if (s[`done_${name}`]) return s;
  const added = await build(s);
  const next = { ...load(), ...added, [`done_${name}`]: true };
  save(next);
  return next;
}
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export const master = () => stage('master', async () => {
  const kg = (await must('owner', 'POST', '/v1/uoms', { uomCode: 'CH-KG', uomName: 'Kilogram' })).uomId;
  const pcs = (await must('owner', 'POST', '/v1/uoms', { uomCode: 'CH-PCS', uomName: 'Pieces' })).uomId;
  const mat = (await must('owner', 'POST', '/v1/materials', { materialCode: 'CH-RM-1', materialName: 'Chain raw material', uomId: kg, qcRequired: true, shelfLifeDays: 730 })).materialId;
  await must('owner', 'POST', '/v1/rm-aliases', { materialId: mat, aliasName: 'CH-RX-1', aliasType: 'FLOOR_CODE' });
  const vendor = (await must('procurement', 'POST', '/v1/vendors', { vendorCode: 'CH-V-1', vendorName: 'Chain Aromatics (test)' })).vendorId;
  await must('procurement', 'POST', '/v1/vendor-rm-mappings', { vendorId: vendor, materialId: mat, isPreferred: true, leadTimeDays: 7 });
  const qcParam = (await must('qc', 'POST', '/v1/qc-parameters', { parameterCode: 'CH-RI', parameterName: 'Refractive index' })).qcParameterId;
  return { kg, pcs, mat, vendor, qcParam };
});

export const formula = () => stage('formula', async () => {
  const { mat } = await master();
  const f = await must('formulator', 'POST', '/v1/formulas', { formulaCode: 'CH-F-1', formulaName: 'Chain oil' }, { vault: true });
  const fv = (await must('formulator', 'POST', '/v1/formula-versions', { formulaId: f.formulaId, versionNumber: 1 }, { vault: true })).formulaVersionId;
  // The main box pushes the material catalogue to the Vault on a timer.
  await until('the material to reach the Vault', async () => (await rp('formulator', 'POST', `/v1/formula-versions/${fv}/ingredients`,
    { ingredients: [{ materialId: mat, percentage: 100, sequenceNo: 1 }] }, { vault: true })).status === 201);
  await must('formulator', 'POST', `/v1/formula-versions/${fv}/submit-for-review`, {}, { vault: true });
  await must('vault_approver', 'POST', `/v1/formula-versions/${fv}/approve`, { remarks: 'ok' }, { vault: true });
  await must('vault_approver', 'POST', `/v1/formula-versions/${fv}/lock`, {}, { vault: true });
  return { formulaId: f.formulaId, fv };
});

/** An issued, acknowledged PO for `qty` of the chain material. */
export async function issuedPo(qty: number) {
  const { mat, kg, vendor } = await master();
  const po = await must('procurement', 'POST', '/v1/purchase-orders', { vendorId: vendor, orderDate: today(),
    items: [{ materialId: mat, orderedQty: qty, uomId: kg, rate: 120, amount: 120 * qty }] });
  const id = po.purchaseOrder.purchaseOrderId;
  await must('owner', 'POST', `/v1/purchase-orders/${id}/approve`, { remarks: 'ok' });
  await must('procurement', 'POST', `/v1/purchase-orders/${id}/issue`, {});
  await must('procurement', 'POST', `/v1/purchase-orders/${id}/acknowledge`, {});
  return { po: id, number: po.purchaseOrder.poNumber as string, poItem: po.items[0].purchaseOrderItemId as string };
}
/** Goods received against a fresh PO: the lot sits in quarantine with its inspection pending. */
export async function receivedLot(qty: number) {
  const { mat, kg, vendor } = await master();
  const { po, poItem } = await issuedPo(qty);
  const g = await must('receiving', 'POST', '/v1/gate-entries', { vendorId: vendor, purchaseOrderId: po, vehicleNumber: 'MP09CH0001', entryDt: new Date().toISOString() });
  const grn = await must('receiving', 'POST', '/v1/grns', { gateEntryId: g.gateEntry.gateEntryId, purchaseOrderId: po, vendorId: vendor, grnDate: today(),
    items: [{ purchaseOrderItemId: poItem, materialId: mat, receivedQty: qty, acceptedQty: qty, rejectedQty: 0, uomId: kg, manufacturingDate: plusDays(-20), expiryDate: plusDays(700) }] });
  const rmBatch = grn.batches[0].rmBatchId as string;
  const insp = await until('the incoming inspection', () => find('qc', '/v1/qc-inspections', (i) => i.rmBatchId === rmBatch));
  return { rmBatch, batchNumber: grn.batches[0].batchNumber as string, grnId: grn.grn.grnId as string, grnNumber: grn.grn.grnNumber as string, insp: insp.qcInspectionId as string };
}
/** A lot through incoming QC and on the warehouse's books. */
export async function releasedStock(qty: number) {
  const { qcParam } = await master();
  const lot = await receivedLot(qty);
  await must('qc', 'POST', `/v1/qc-inspections/${lot.insp}/results`, { results: [{ qcParameterId: qcParam, observedValue: 1.47, result: 'PASS' }] });
  await must('qc', 'POST', `/v1/qc-inspections/${lot.insp}/disposition`, { dispositionCode: 'ACCEPT', dispositionReason: 'within spec' });
  const inv = await until('released stock', () => find('warehouse', '/v1/inventory-batches', (b) => b.rmBatchId === lot.rmBatch));
  return { ...lot, invBatch: inv.inventoryBatchId as string };
}
/** A production order with reserved, picked and issued stock: ready to weigh. */
export async function orderWithIssuedStock(qty = 5) {
  const { fv, kg, mat } = { ...(await formula()), ...(await master()) };
  const { invBatch } = await releasedStock(qty);
  const order = (await must('production', 'POST', '/v1/production-orders', { formulaVersionId: fv, orderQty: qty, uomId: kg })).order.productionOrderId as string;
  await must('warehouse', 'POST', '/v1/stock-reservations', { inventoryBatchId: invBatch, reservedQty: qty, uomId: kg, reservedForDocumentId: order });
  const pl = await must('production', 'POST', `/v1/production-orders/${order}/pick-list`, { pickListDate: today() });
  await must('compounding', 'POST', '/v1/material-issues', { productionOrderId: order, materialPickListId: pl.pickList.materialPickListId,
    items: [{ materialId: mat, inventoryBatchId: invBatch, uomId: kg }] });
  return { order, invBatch, qty };
}
/** Mixed, QC'd, matured and released oil. */
export async function releasedOil(batchNumber: string, qty = 5) {
  const { kg, qcParam } = await master();
  const { order } = await orderWithIssuedStock(qty);
  const mix = (await must('compounding', 'POST', '/v1/mixing-sessions', { productionOrderId: order })).secureMixingSessionId;
  await must('compounding', 'POST', `/v1/mixing-sessions/${mix}/weighings`, { sequenceNo: 1, grossQty: qty + 0.45, tareQty: 0.45, scaleRef: 'BAL-01' });
  await must('compounding', 'POST', `/v1/mixing-sessions/${mix}/steps`, { stepSequence: 1, stepDescription: 'charge per coded instruction' });
  await must('compounding', 'POST', `/v1/mixing-sessions/${mix}/end`, {});
  const oil = (await must('compounding', 'POST', '/v1/oil-batches', { productionOrderId: order, secureMixingSessionId: mix, batchNumber, producedQty: qty, uomId: kg })).batch.oilBatchId;
  const qcBody = { oilBatchId: oil, qcParameterId: qcParam, observedValue: 1.47, specMin: 1.46, specMax: 1.48 };
  await must('qc', 'POST', '/v1/production-qc', qcBody);
  await must('compounding', 'POST', `/v1/oil-batches/${oil}/transition`, { status: 'IN_MATURATION' });
  await must('qc', 'POST', '/v1/production-qc', qcBody);
  await must('compounding', 'POST', `/v1/oil-batches/${oil}/transition`, { status: 'RELEASED' });
  return { oil: oil as string, order, mix };
}
export const sku = () => stage('sku', async () => {
  const { pcs } = await master();
  const product = (await must('owner', 'POST', '/v1/products', { productCode: 'CH-PRD-1', productName: 'Chain oil 1 kg' })).productId;
  const skuId = (await must('owner', 'POST', '/v1/product-skus', { skuCode: 'CH-SKU-1', productId: product })).productSkuId;
  const pm = (await must('owner', 'POST', '/v1/packaging-materials', { packagingMaterialCode: 'CH-PM-1', packagingMaterialName: '1 kg aluminium bottle', uomId: pcs })).packagingMaterialId;
  await must('owner', 'POST', '/v1/packaging-boms', { productSkuId: skuId, packagingMaterialId: pm, requiredQty: 1, uomId: pcs });
  await must('warehouse', 'POST', '/v1/inventory-batches', { materialId: pm, quantityOnHand: 500, uomId: pcs });
  return { product, skuId, pm };
});
/** A package order with materials issued and its fill finished. */
export async function filledPackageOrder(oilBatchNumber: string, qty = 5) {
  const { kg, skuId } = { ...(await master()), ...(await sku()) };
  const { oil } = await releasedOil(oilBatchNumber, qty);
  const pkg = (await must('packaging', 'POST', '/v1/package-orders', { productSkuId: skuId, oilBatchId: oil, orderQty: qty, uomId: kg })).order.packageOrderId as string;
  await must('packaging', 'POST', `/v1/package-orders/${pkg}/issue-materials`, {});
  const fill = (await must('filling', 'POST', '/v1/filling-sessions', { packageOrderId: pkg })).fillingSessionId as string;
  await must('filling', 'POST', `/v1/filling-sessions/${fill}/details`, { filledQty: qty, rejectedQty: 0, uomId: kg });
  await must('filling', 'POST', `/v1/filling-sessions/${fill}/end`, {});
  return { pkg, oil, fill, qty, skuId };
}
/** A finished batch: labelled, packaging QC passed, released. */
export async function releasedFinishedBatch(fgNumber: string, qty = 5) {
  const { kg } = await master();
  const { pkg, skuId } = await filledPackageOrder(`OB-${fgNumber}`, qty);
  const fg = (await must('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: pkg, productSkuId: skuId, batchNumber: fgNumber, producedQty: qty, uomId: kg, manufacturingDate: today(), expiryDate: plusDays(700) })).batch.finishedGoodBatchId as string;
  await must('packaging', 'POST', `/v1/finished-good-batches/${fg}/labels`, { labelCount: 1 });
  await must('packaging', 'POST', `/v1/package-orders/${pkg}/complete`, {});
  await must('packaging', 'POST', '/v1/packaging-qc', { finishedGoodBatchId: fg, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' });
  await until('FG release', async () => (await find('packaging', '/v1/finished-good-batches', (x) => x.finishedGoodBatchId === fg))?.status === 'RELEASED');
  return { fg, skuId, pkg, qty };
}

export const BRIDGE_SECRET = 'browser-suite-bridge-secret-not-a-real-credential';
export const bridge = () => stage('bridge', async () => {
  await must('owner', 'PUT', '/v1/bridge/config', { enabled: true, hmacSecret: BRIDGE_SECRET, webhookUrl: `http://127.0.0.1:${PORTS.deadPeer}/bridge` });
  return {};
});
/** Link the chain product's formula, so Produce next can plan from it. */
export const producible = () => stage('producible', async () => {
  const { formulaId } = await formula(); const { product } = await sku();
  await must('owner', 'POST', `/v1/products/${product}/formula-link`, { formulaId, reason: 'browser suite chain' });
  return {};
});
/** ALEMBIC's signed "please produce this": the real inbound route, the real HMAC check. */
export async function signedEvent(type: string, aggregateId: string, payload: Record<string, unknown>, version = 1) {
  await bridge();
  const event = { event_id: randomUUID(), version, type, aggregate: { type: 'production_requirement', id: aggregateId }, org_id: '00000000-0000-4000-8000-000000000001', correlation_id: randomUUID(), causation_id: null,
    occurred_at: new Date().toISOString(), source: 'alembic', payload };
  const raw = JSON.stringify(event);
  const res = await fetch(`${API}/v1/bridge/alembic/events`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json',
    'x-bridge-event-id': event.event_id, 'x-bridge-signature': `sha256=${createHmac('sha256', BRIDGE_SECRET).update(raw, 'utf8').digest('hex')}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
export async function requirement(orderRef: string, qtyKg = 3) {
  await producible();
  const id = randomUUID();
  const r = await signedEvent('ProductionRequirementCreated', id, { order_ref: orderRef, mapped_sku: 'CH-SKU-1', qty: qtyKg, uom: 'kg', needed_by: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  if (r.status >= 300) throw new Error(`chain: requirement ${r.status} ${JSON.stringify(r.body)}`);
  return { requirementId: id };
}
