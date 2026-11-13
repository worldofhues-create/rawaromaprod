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

// A token is reused for 4 minutes, then signed in again. Step-up actions (a vault approval) need a session
// issued within the last 300s, and a whole run is far longer than that, so a token kept for the run was
// refused (AUTH_STEP_UP_REQUIRED) the moment the suite grew past five minutes before the vault specs.
const TOKEN_REUSE_MS = 240_000;
const tokens = new Map<string, { token: string; at: number }>();
const API = `http://127.0.0.1:${PORTS.api}`;
const VAULT = `http://127.0.0.1:${PORTS.vaultApi}`;

async function tokenFor(role: string, target: ConsoleName) {
  const k = `${role}|${target}`;
  const hit = tokens.get(k);
  if (hit && Date.now() - hit.at < TOKEN_REUSE_MS) return hit.token;
  const res = await fetch(`${API}/auth/alembic-assertion`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: mintAssertion(EMAIL[role]!, target) }) });
  const j: any = await res.json();
  if (!j?.data?.accessToken) throw new Error(`sign-in for ${role} failed: ${res.status} ${JSON.stringify(j?.error)}`);
  tokens.set(k, { token: j.data.accessToken, at: Date.now() });
  return j.data.accessToken as string;
}

export async function rp(role: string, method: string, path: string, body?: unknown, opts: { vault?: boolean } = {}) {
  const res = await fetch(`${opts.vault ? VAULT : API}${path}`, { method,
    headers: { authorization: `Bearer ${await tokenFor(role, opts.vault ? 'vault' : 'factory')}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let j: any = {}; try { j = JSON.parse(text); } catch { j = { data: text }; }
  return { status: res.status, body: j.data, error: j.error, cursor: (j.meta?.cursor ?? null) as string | null };
}
/** A precondition that fails stops the walk loudly: it must never read as the flow passing. */
export async function must(role: string, method: string, path: string, body?: unknown, opts: { vault?: boolean } = {}) {
  const r = await rp(role, method, path, body, opts);
  if (r.status >= 300) throw new Error(`chain: ${role} ${method} ${path} -> ${r.status} ${JSON.stringify(r.error)}`);
  return r.body;
}
/** STOCK-FIX-RP (STK-27): a typed verify weight with a second person's sign-off (verifier asks, admin signs). */
export async function signedTypedE2e(mg: number): Promise<{ source: 'typed'; weightCheckId: string }> {
  const c = (await must('verifier', 'POST', '/v1/scales/typed-checks', { station: 'Floor', mg, reason: 'e2e: no scale connected' })) as { checkId: string };
  await must('admin', 'POST', `/v1/scales/typed-checks/${c.checkId}/sign`, {});
  return { source: 'typed', weightCheckId: c.checkId };
}
/**
 * STOCK-E2E-2: the second person's half of a weight typed ON THE VERIFY SCREEN. The screen asks for the sign-off
 * on the first press and sends the weight on the press after it is signed (STK-27); the walks that type a weight
 * in the browser never signed, so they stopped at "waiting for a verifier or supervisor to sign it". This signs
 * the pending check of that weight as the admin, which is what the Devices screen's Sign button does.
 */
export async function signTypedOnScreen(mg: number): Promise<void> {
  // Every pending check of that weight: a walk that stopped earlier leaves its own behind, and the list does not
  // say which one this page holds.
  const pending = await until(`a pending typed check of ${mg} mg`, async () => {
    const list = (await must('admin', 'GET', '/v1/scales/typed-checks')) as { items?: Array<{ checkId: string; mg: number | string; status: string }> };
    const mine = (list.items ?? []).filter((c) => Number(c.mg) === mg && c.status === 'PENDING');
    return mine.length ? mine : null;
  }, 15_000);
  for (const c of pending) await must('admin', 'POST', `/v1/scales/typed-checks/${c.checkId}/sign`, {});
}
/**
 * STAGE-2-RP (STK-44): a weight typed at the PACKING station (no scale is connected in a walk) is accepted
 * only once a second person has signed it (FLOOR-FIX-3/16). The first press asks why it was typed and files
 * the weight for a sign-off; the press after the sign-off sends it. Two walks pressed once and waited for the
 * result, which is not what the screen asks of a person. Both halves: the packer answers the question, the
 * admin signs the pending weight (Floor devices, Typed weights, Sign), and the packer presses again.
 */
export async function typedThenSigned(page: import('@playwright/test').Page, button: string, field: string, mg: number): Promise<void> {
  await page.getByRole('button', { name: button }).click();
  await page.getByRole('button', { name: 'Ask for a sign-off', exact: true }).click();
  await page.locator(`#${field}-src`).filter({ hasText: 'waiting for a second person to sign' }).waitFor({ timeout: 15_000 });
  await signTypedOnScreen(mg);
  await page.getByRole('button', { name: button }).click();
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
/* STAGE-2-RP: this read the first 100 rows and stopped. Lists are newest id first, and the floor walks
 * insert lots and inspections by SQL with random ids, most of which sort ahead of the server's time-ordered
 * ones; past a hundred of those, a lot received a second ago was on page two and every chain walk timed out
 * "waiting for the incoming inspection". It reads every page, as the consoles do (WALK-RP: lists read every page). */
const find = async (role: string, path: string, hit: (r: any) => boolean) => {
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const r = await rp(role, 'GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status >= 300) throw new Error(`chain: ${role} GET ${path} -> ${r.status} ${JSON.stringify(r.error)}`);
    const found = ((r.body ?? []) as any[]).find(hit);
    if (found) return found;
    cursor = r.cursor;
    if (!cursor) return undefined;
  }
  return undefined;
};

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
  // STAGE-2-RP: the chain's kilogram was a made-up unit, 'CH-KG'. Since STK-8 a batch is ordered in a unit
  // the factory weighs in (kg, g or mg), so every walk that raised a production order through the chain
  // was refused at its first step: eleven walks, red on the stock lane itself. It is the real unit now,
  // found if a walk before this one put it on file, made if not.
  const kg = ((await find('owner', '/v1/uoms', (u) => String(u.uomCode ?? '').toLowerCase() === 'kg')) ?? (await must('owner', 'POST', '/v1/uoms', { uomCode: 'kg', uomName: 'Kilogram' }))).uomId as string;
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
  await must('qc', 'POST', '/v1/qc-sample-retentions', { qcInspectionId: lot.insp, rmBatchId: lot.rmBatch, sampleCode: `RS-${lot.batchNumber}`, retainedDt: new Date().toISOString() }); // FLOOR-QC-IN-1: the sample drawn and kept
  await must('qc', 'POST', `/v1/qc-inspections/${lot.insp}/disposition`, { dispositionCode: 'ACCEPT', dispositionReason: 'within spec' });
  const inv = await until('released stock', () => find('warehouse', '/v1/inventory-batches', (b) => b.rmBatchId === lot.rmBatch));
  return { ...lot, invBatch: inv.inventoryBatchId as string };
}
/**
 * STAGE-2-RP: stock for an order is reserved when the order is planned (STK-7 to STK-9); nobody reserves it by
 * hand afterwards. The chain still did, found nothing left to reserve ("only 0 kg available") and stopped
 * every walk that makes a batch. It now checks that planning reserved the order's stock, and reserves by hand
 * only for an order planning could not cover (which the old step was for).
 */
export async function reservedFor(order: string, invBatch: string, qty: number, uomId: string): Promise<void> {
  const held = await find('warehouse', '/v1/stock-reservations', (r) => r.reservedForDocumentId === order && !r.releasedDt);
  if (!held) await must('warehouse', 'POST', '/v1/stock-reservations', { inventoryBatchId: invBatch, reservedQty: qty, uomId, reservedForDocumentId: order });
}
/** A production order with reserved, picked and issued stock: ready to weigh. */
export async function orderWithIssuedStock(qty = 5) {
  const { fv, kg, mat } = { ...(await formula()), ...(await master()) };
  const { invBatch } = await releasedStock(qty);
  // Through a plan line carrying the formula: that link is how the certificate step finds the product.
  const { formulaId } = await formula();
  const plan = (await must('production', 'POST', '/v1/production-plans', { planDate: today() })).productionPlanId;
  const line = (await must('production', 'POST', '/v1/production-plan-items', { productionPlanId: plan, formulaId, plannedQty: qty, uomId: kg })).productionPlanItemId;
  const order = (await must('production', 'POST', '/v1/production-orders', { formulaVersionId: fv, productionPlanItemId: line, orderQty: qty, uomId: kg })).order.productionOrderId as string;
  await reservedFor(order, invBatch, qty, kg);
  const pl = await must('production', 'POST', `/v1/production-orders/${order}/pick-list`, { pickListDate: today() });
  await must('compounding', 'POST', '/v1/material-issues', { productionOrderId: order, materialPickListId: pl.pickList.materialPickListId,
    items: [{ materialId: mat, inventoryBatchId: invBatch, uomId: kg }] });
  return { order, invBatch, qty };
}
/* ── STAGE-2-RP: the release as the merged branch enforces it ────────────────────────────────────────
 * The chain made a batch the way the factory did before the promises: a typed batch number, a typed QC
 * pass, IN_MATURATION and RELEASED one after the other. The server refuses each of those now, so nine
 * walks never reached their screen. This drives the real process, by the routes the screens call:
 *
 *   the number      the server assigns it (PROM-4); the chain reads it back and hands it to the walk
 *   QC 1            a round on the product's published checkpoints, which include the comparison with
 *                   the retained reference (PROM-3). The chain product has no retained reference (that is
 *                   a physical bottle two people approve), so the round records NO_REFERENCE_YET
 *   the rest        every batch rests 45 days (PROM-2). A walk cannot wait and must not weaken the rule,
 *                   so it takes the path the floor has: QC ASKS for an early release with a reason, and a
 *                   SECOND person (the owner) approves it. The rule itself is left at 45 days
 *   QC 2            a retained sample of this batch on file, then a round taken after the rest ended
 *   release         IN_MATURATION -> RELEASED, which closes the rest and sends its record
 */
type Cp = { id: string; checkType: string; min: number | null; max: number | null; photoRequired?: boolean };
/** The chain product's checkpoints: the version in force, or (the first time) one published as QC would. */
async function qcCheckpoints(): Promise<{ product: string; results: Array<Record<string, unknown>> }> {
  const { product } = await sku();
  const read = async () => ((await must('qc', 'GET', `/v1/prodfloor/qc/checkpoints/${product}`)).checkpoints ?? []) as Cp[];
  let cps = await read();
  if (!cps.length) {
    await must('qc', 'POST', `/v1/prodfloor/qc/checkpoints/${product}`, { reason: 'browser suite: the first version',
      checkpoints: [{ name: 'Odour profile', checkType: 'PASS_FAIL', critical: true }, { name: 'Against the retained reference', checkType: 'REFERENCE' }] });
    cps = await read();
  }
  // Every checkpoint answered as passing: a range by its midpoint, a photo by a reference to one.
  const results = cps.map((c) => ({ checkpointId: c.id, pass: true,
    ...(c.checkType === 'RANGE' && c.min != null && c.max != null ? { value: (c.min + c.max) / 2 } : {}), ...(c.photoRequired ? { photoRef: 'walk-photo' } : {}) }));
  return { product, results };
}
/** One QC round on the batch; the walk stops if QC did not approve it. */
async function qcRound(oil: string, stage: 'QC 1' | 'QC 2', body: Record<string, unknown>) {
  const r = await must('qc', 'POST', `/v1/prodfloor/qc/batches/${oil}/rounds`, body);
  if (r?.decision && r.decision !== 'APPROVE') throw new Error(`chain: ${stage} on ${oil} was ${r.decision}, not APPROVE: ${JSON.stringify(r).slice(0, 300)}`);
}
/** A batch that has been mixed and recorded: the server's number, nothing decided yet (QC_PENDING). */
export async function mixedOil(qty = 5) {
  const { kg } = await master();
  const { order } = await orderWithIssuedStock(qty);
  const mix = (await must('compounding', 'POST', '/v1/mixing-sessions', { productionOrderId: order })).secureMixingSessionId;
  await must('compounding', 'POST', `/v1/mixing-sessions/${mix}/weighings`, { sequenceNo: 1, grossQty: qty + 0.45, tareQty: 0.45, scaleRef: 'BAL-01' });
  await must('compounding', 'POST', `/v1/mixing-sessions/${mix}/steps`, { stepSequence: 1, stepDescription: 'charge per coded instruction' });
  await must('compounding', 'POST', `/v1/mixing-sessions/${mix}/end`, {});
  const made = (await must('compounding', 'POST', '/v1/oil-batches', { productionOrderId: order, secureMixingSessionId: mix, producedQty: qty, uomId: kg })).batch;
  return { oil: made.oilBatchId as string, batchNumber: made.batchNumber as string, order, mix };
}
/** QC 1 approved and the batch resting: the rest run is open. */
export async function restingOil(qty = 5) {
  const { qcParam } = await master();
  const b = await mixedOil(qty);
  const { product, results } = await qcCheckpoints();
  await must('qc', 'POST', '/v1/production-qc', { oilBatchId: b.oil, qcParameterId: qcParam, observedValue: 1.47, specMin: 1.46, specMax: 1.48 });
  await qcRound(b.oil, 'QC 1', { productId: product, results });
  await must('compounding', 'POST', `/v1/oil-batches/${b.oil}/transition`, { status: 'IN_MATURATION' });
  const run = await until('the rest run', async () => (((await must('qc', 'GET', '/v1/maceration/runs')).items ?? []) as any[]).find((r) => (r.oilBatchId ?? r.oil_batch_id) === b.oil));
  return { ...b, run: (run.macerationRunId ?? run.maceration_run_id) as string, product, results };
}
/** Mixed, QC 1, rested (an early release by two people), QC 2 and released. */
export async function releasedOil(qty = 5) {
  const { qcParam } = await master();
  const b = await restingOil(qty);
  await must('qc', 'POST', `/v1/maceration/runs/${b.run}/release-early`, { reasonCode: 'other', reason: 'browser suite: a walk cannot wait 45 days for the rest' });
  await must('owner', 'POST', `/v1/maceration/runs/${b.run}/release-early/approve`, { note: 'browser suite: second person' });
  await must('qc', 'POST', '/v1/qc-sample-retentions', { oilBatchId: b.oil, sampleCode: `RS-${b.batchNumber}`, retainedDt: new Date().toISOString() });
  await must('qc', 'POST', '/v1/production-qc', { oilBatchId: b.oil, qcParameterId: qcParam, observedValue: 1.47, specMin: 1.46, specMax: 1.48 });
  await qcRound(b.oil, 'QC 2', { results: b.results });
  await must('compounding', 'POST', `/v1/oil-batches/${b.oil}/transition`, { status: 'RELEASED' });
  return { oil: b.oil, order: b.order, mix: b.mix, batchNumber: b.batchNumber };
}
/** QC's release of the oil batch: the gate labels now stand behind. */
export async function releasedCoa(oil: string) {
  const { product } = await producible().then(() => sku());
  await must('qc', 'PUT', `/v1/product-qc-specs/${product}`, { sgMin: 0.5, sgMax: 2, flashPointMinC: 20, flashPointMaxC: 120, shelfLifeMonths: 24 });
  const made = await must('qc', 'POST', '/v1/batch-coas', { oilBatchId: oil, productId: product, sgResult: 1, flashPointResultC: 60, colourAppearance: 'Clear', colourAppearancePass: true, odourDescription: 'Conforms', odourPass: true });
  const coa = (made.batchCoaId ?? made.coa?.batchCoaId) as string;
  await must('qc', 'POST', `/v1/batch-coas/${coa}/release`, {});
  return coa;
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
export async function filledPackageOrder(qty = 5) {
  const { kg, skuId } = { ...(await master()), ...(await sku()) };
  const { oil, batchNumber: oilBatchNumber } = await releasedOil(qty);
  const pkg = (await must('packaging', 'POST', '/v1/package-orders', { productSkuId: skuId, oilBatchId: oil, orderQty: qty, uomId: kg })).order.packageOrderId as string;
  await must('packaging', 'POST', `/v1/package-orders/${pkg}/issue-materials`, {});
  const fill = (await must('filling', 'POST', '/v1/filling-sessions', { packageOrderId: pkg })).fillingSessionId as string;
  await must('filling', 'POST', `/v1/filling-sessions/${fill}/details`, { filledQty: qty, rejectedQty: 0, uomId: kg });
  await must('filling', 'POST', `/v1/filling-sessions/${fill}/end`, {});
  return { pkg, oil, oilBatchNumber, fill, qty, skuId };
}
/** A finished batch: labelled, packaging QC passed, released. */
export async function releasedFinishedBatch(qty = 5) {
  const { kg } = await master();
  const { pkg, skuId, oil, oilBatchNumber } = await filledPackageOrder(qty);
  await releasedCoa(oil);
  // PROM-4: the lot is assigned by the server at fill; the walk reads it, as a person reads it off the screen.
  const made = (await must('packaging', 'POST', '/v1/finished-good-batches', { packageOrderId: pkg, productSkuId: skuId, producedQty: qty, uomId: kg, manufacturingDate: today(), expiryDate: plusDays(700) })).batch;
  const fg = made.finishedGoodBatchId as string, fgNumber = made.batchNumber as string;
  await must('packaging', 'POST', `/v1/finished-good-batches/${fg}/labels`, { labelCount: 1 });
  await must('packaging', 'POST', `/v1/package-orders/${pkg}/complete`, {});
  await must('packaging', 'POST', '/v1/packaging-qc', { finishedGoodBatchId: fg, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' });
  await until('FG release', async () => (await find('packaging', '/v1/finished-good-batches', (x) => x.finishedGoodBatchId === fg))?.status === 'RELEASED');
  return { fg, fgNumber, oilBatchNumber, skuId, pkg, qty };
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
