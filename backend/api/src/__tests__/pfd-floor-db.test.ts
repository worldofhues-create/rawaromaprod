/**
 * PROD-D-4..6 — order intelligence, the queue's pipeline view and the QC review decision against real
 * Postgres: planning.cover holds until a rule exists; a rule sizes a suggestion from ALEMBIC inflow
 * with its reasoning; a held batch blocks the product; approving recomputes, stores the reasoning
 * and raises a draft PR for short raw stock; approved suggestions sit below customer jobs; a REVIEW
 * batch is decided by two people, one of each signature, and the decision lands in the genealogy.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { PolicyService } from '../policy/policy.service.js';
import { CoverService } from '../planning/cover.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { FloorQueueService } from '../floor/floor-queue.service.js';
import { QcReviewService } from '../prodfloor/qc-review.service.js';
import { PERM_APPROVER, PERM_PERFUMER, PERM_READ } from '../prodfloor/qc-review.js';

const sql = () => testClient();
let policies: PolicyService, cover: CoverService, queue: FloorQueueService, review: QcReviewService;
const DAY = 86_400_000;
const NOW = new Date();
const admin = principal({ userId: '00000000-0000-7000-8000-0000000000d1', roles: ['admin'] });
const planner = principal({ userId: '00000000-0000-7000-8000-0000000000d2', roles: ['production'] });
const perfumer = principal({ userId: '00000000-0000-7000-8000-0000000000d3', roles: ['formulator'], permissions: [PERM_READ, PERM_PERFUMER] });
const approver = principal({ userId: '00000000-0000-7000-8000-0000000000d4', roles: ['vault_approver'], permissions: [PERM_READ, PERM_APPROVER] });
const perfumer2 = principal({ userId: '00000000-0000-7000-8000-0000000000d5', roles: ['formulator'], permissions: [PERM_READ, PERM_PERFUMER] });

before(async () => {
  await ensureSchema();
  const s = sql();
  policies = new PolicyService(s);
  cover = new CoverService(s, policies);
  queue = new FloorQueueService(s, policies, new FloorCodeService(s));
  review = new QcReviewService(s);
});
after(async () => { await closeTestClient(); });

async function product(name: string) {
  const s = sql(), productId = randomUUID(), formulaId = randomUUID(), sku = 'PFD-' + randomUUID().slice(0, 8);
  await s`insert into packaging.product_master (product_id, formula_id, product_name) values (${productId}, ${formulaId}, ${name})`;
  const skuId = String((await s`insert into packaging.product_sku (product_id, sku_code) values (${productId}, ${sku}) returning product_sku_id`)[0]!.product_sku_id);
  return { productId, formulaId, sku, skuId };
}
async function requirement(sku: string, qty: number, daysAgo: number, poId: string | null = null, orderRef = 'ORD-' + randomUUID().slice(0, 8)) {
  await sql()`insert into bridge.production_requirement (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, lifecycle_status, production_order_id, created_dt)
    values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${orderRef}, ${sku}, ${qty}, 'unit', ${new Date(NOW.getTime() + 7 * DAY).toISOString()}, 'ACCEPTED', ${poId},
            ${new Date(NOW.getTime() - daysAgo * DAY).toISOString()})`;
  return orderRef;
}
/** Only this SKU gets a rule: other tests' products keep holding. */
async function rule(sku: string, then: unknown) {
  await policies.publish('planning.cover', { rules: [{ id: 'r-' + sku, scope: 'global', when: [{ field: 'sku', op: 'eq', value: sku }], then }], hasDefault: false }, 'PROD-D test rule for ' + sku, admin);
}

test('cover: no planning.cover rule for a product -> HOLD with the reason, even with demand', async () => {
  const p = await product('Hold accord');
  for (let w = 0; w < 10; w++) await requirement(p.sku, 30, w * 7 + 1);
  const r = await cover.compute({ sku: p.sku });
  assert.equal(r.items[0]!.status, 'HOLD');
  assert.match(r.items[0]!.why, /planning\.cover/);
  assert.equal(typeof r.policyStatus.note, 'string');
});

test('cover: a rule sizes the suggestion from inflow; a held batch blocks it; approve stores reasoning and raises a draft PR for short raw stock', async () => {
  const s = sql();
  const p = await product('Aventus-type accord');
  // 26 weeks at ~38/week, plus one one-off bulk order
  for (let w = 0; w < 26; w++) await requirement(p.sku, 38, w * 7 + 1);
  await requirement(p.sku, 900, 2, null, 'BULK-' + p.sku);
  // a finished production order gives the bill of materials: 10 units used 5 kg of one material
  const mat = randomUUID(), kg = randomUUID(), po = randomUUID();
  await s`insert into masterdata.material (material_id, material_code, material_name) values (${mat}, ${'PFD-M-' + p.sku}, 'm')`;
  await s`insert into platform.uom_master (uom_id, uom_code, uom_name) values (${kg}, ${'K' + p.sku.slice(-6)}, 'kg-test')`;
  await s`insert into production.production_order (production_order_id, order_qty, status) values (${po}, 10, 'COMPLETED')`;
  await s`insert into production.production_order_ingredients (production_order_id, material_id, required_qty, uom_id) values (${po}, ${mat}, 5, ${kg})`;
  await requirement(p.sku, 10, 200, po);
  await rule(p.sku, { mode: 'dynamic', defaultLeadDays: 21 });

  let it = (await cover.compute({ sku: p.sku })).items[0]!;
  assert.equal(it.status, 'SUGGEST', it.why);
  assert.ok(it.qty > 0);
  assert.match(it.why, /^Make \d+: sells ~38\/week/);
  assert.match(it.why, new RegExp('left out as one-off: BULK-' + p.sku));
  assert.equal(it.raw.checked, true);
  assert.equal(it.raw.short.length, 1, 'no stock of the one material: short');
  assert.equal(it.policy.version != null, true);

  // an open hold on a batch of this product blocks it outright
  const ob = randomUUID();
  await s`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number) values (${ob}, ${po}, ${'OB-' + p.sku})`;
  const hold = String((await s`insert into inventory.lot_hold (subject_type, subject_id, reason, source) values ('OIL_BATCH', ${ob}, 'QC REJECT: test', 'QC_ROUND') returning lot_hold_id`)[0]!.lot_hold_id);
  it = (await cover.compute({ sku: p.sku })).items[0]!;
  assert.equal(it.status, 'BLOCKED');
  assert.match(it.why, new RegExp('OB-' + p.sku));
  await assert.rejects(() => cover.approve({ sku: p.sku }, planner), /Nothing to approve/);
  await s`update inventory.lot_hold set released_dt = now(), released_by = 'test', release_reason = 'test' where lot_hold_id = ${hold}`;

  await assert.rejects(() => cover.dismiss({ sku: p.sku }, planner), /Say why/);
  await assert.rejects(() => cover.approve({ sku: p.sku, qty: 5 }, planner), /Say why the approved quantity differs/);
  const a = await cover.approve({ sku: p.sku }, planner);
  assert.equal(a.purchaseRequestIds.length, 1);
  const pr = (await s`select status, pr_number from procurement.purchase_request where purchase_request_id = ${a.purchaseRequestIds[0]!}`)[0]!;
  assert.equal(pr.status, 'DRAFT');
  const sr = (await s`select requirement_source from procurement.stock_requirement sr join procurement.purchase_request p on p.stock_requirement_id = sr.stock_requirement_id where p.purchase_request_id = ${a.purchaseRequestIds[0]!}`)[0]!;
  assert.equal(sr.requirement_source, 'COVER_SUGGESTION:' + p.sku);
  const row = (await s`select status, reasoning, decided_by, policy_version from production.cover_suggestion where cover_suggestion_id = ${a.coverSuggestionId}`)[0]!;
  assert.equal(row.status, 'APPROVED');
  assert.equal(row.decided_by, planner.userId);
  assert.match(String(row.reasoning), /^Make /);

  // approved and not yet started counts as planned stock: not suggested twice
  it = (await cover.compute({ sku: p.sku })).items[0]!;
  assert.notEqual(it.status, 'SUGGEST', it.why);
  assert.match(it.why, /approved and not started/);

  // and it shows in the floor queue's planned list, below customer orders
  const q = await queue.queue('VERIFY');
  const planned = q.planned.find((x) => x.coverSuggestionId === a.coverSuggestionId);
  assert.ok(planned, 'approved suggestion listed as planned');
  assert.match(String(planned!.why), /below every customer order/);
});

test('cover: a planner flags an order recurring or excluded; an excluded order leaves the demand', async () => {
  const p = await product('Flag accord');
  for (let w = 0; w < 6; w++) await requirement(p.sku, 10, w * 7 + 1);
  const big = await requirement(p.sku, 400, 3);
  await rule(p.sku, { mode: 'fixed', coverWeeks: 4 });
  let it = (await cover.compute({ sku: p.sku })).items[0]!;
  assert.deepEqual(it.numbers.excludedOrders, [big]);
  await assert.rejects(() => cover.flagOrder({ orderRef: big, flag: 'RECURRING' }, planner), /Say why/);
  await cover.flagOrder({ orderRef: big, flag: 'RECURRING', reason: 'quarterly trade order' }, planner);
  it = (await cover.compute({ sku: p.sku })).items[0]!;
  assert.deepEqual(it.numbers.excludedOrders, []);
  await cover.flagOrder({ orderRef: big, flag: 'EXCLUDE', reason: 'sample order, not demand' }, planner);
  it = (await cover.compute({ sku: p.sku })).items[0]!;
  assert.ok(!it.numbers.weeks.some((x) => x >= 400));
});

test('queue: a SUGGESTED job ranks below an ORDER job, and every job carries a prediction', async () => {
  const s = sql(), t = randomUUID().slice(0, 6);
  const mk = async (no: string, source: string) => {
    const id = randomUUID();
    await s`insert into production.floor_job (floor_job_id, job_no, production_order_id, material_pick_list_id, stage, source) values (${id}, ${no}, ${randomUUID()}, ${randomUUID()}, 'VERIFY', ${source})`;
    return id;
  };
  const sug = await mk(`SG-${t}`, 'SUGGESTED');
  const ord = await mk(`OR-${t}`, 'ORDER');
  const q = await queue.queue('VERIFY');
  const ix = (id: string) => q.items.findIndex((i) => i.floorJobId === id);
  assert.ok(ix(ord) >= 0 && ix(sug) > ix(ord));
  assert.equal(q.items[ix(sug)]!.priority, 'SUGGESTED');
  assert.ok(q.items[ix(ord)]!.prediction, 'prediction present');
  assert.equal(typeof q.items[ix(ord)]!.prediction!.explain, 'string');
  assert.equal(typeof q.pipeline.atRisk, 'number');
});

async function reviewBatch(name: string) {
  const s = sql();
  const p = await product(name);
  const ob = randomUUID();
  await s`insert into production.oil_batch_master (oil_batch_id, batch_number, produced_qty) values (${ob}, ${'RV-' + ob.slice(0, 6)}, 10)`;
  const set = String((await s`insert into quality.qc_checkpoint_set (product_id, version, reason) values (${p.productId}, 1, 'test') returning qc_checkpoint_set_id`)[0]!.qc_checkpoint_set_id);
  for (const [n, d] of [[1, 'REWORK'], [2, 'REWORK'], [3, 'REVIEW']] as const) {
    await s`insert into quality.batch_qc_round (oil_batch_id, round_no, qc_checkpoint_set_id, inspector_id, results, decision, reasons, rework_no, policy_version)
            values (${ob}, ${n}, ${set}, 'qc', '{}'::jsonb, ${d}, '["test"]'::jsonb, ${n - 1}, 1)`;
  }
  await s`insert into inventory.lot_hold (subject_type, subject_id, reason, source) values ('OIL_BATCH', ${ob}, 'QC REVIEW', 'QC_ROUND')`;
  return { ...p, ob };
}

test('review: downgrade and reblend are disabled with the reason until defined; two different people, one of each signature, decide', async () => {
  const s = sql();
  const b = await reviewBatch('Review accord');
  let d = await review.detail(b.ob);
  assert.equal(d.inReview, true);
  assert.equal(d.options.REJECT.enabled, true);
  assert.equal(d.options.DOWNGRADE.enabled, false);
  assert.match(d.options.DOWNGRADE.why, /No downgrade target is defined for Review accord/);
  assert.equal(d.options.REBLEND.enabled, false);
  assert.ok((await review.list()).some((r) => r.oilBatchId === b.ob));
  await assert.rejects(() => review.propose(b.ob, { outcome: 'DOWNGRADE', reason: 'x' }, perfumer), /No downgrade target/);
  await assert.rejects(() => review.propose(b.ob, { outcome: 'REJECT', reason: 'x' }, planner), /perfumer or a vault approver/);

  await review.setDowngradeTarget(b.productId, { targetGrade: 'Industrial grade', reason: 'sold to soap makers' }, approver);
  await review.setReblendRule(b.formulaId, { reblendAllowed: true, maxSharePct: 10, reason: 'tolerates 10%' }, approver);
  d = await review.detail(b.ob);
  assert.equal(d.options.DOWNGRADE.enabled, true);
  assert.equal(d.options.REBLEND.enabled, true);
  await assert.rejects(() => review.propose(b.ob, { outcome: 'REBLEND', reason: 'fold', reblendShareBps: 2000 }, perfumer), /at most 10%/);

  const pr = await review.propose(b.ob, { outcome: 'DOWNGRADE', reason: 'odour fine, strength low' }, perfumer);
  assert.equal(pr.proposedAs, 'PERFUMER');
  await assert.rejects(() => review.propose(b.ob, { outcome: 'REJECT', reason: 'x' }, approver), /already proposed/);
  await assert.rejects(() => review.confirm(b.ob, {}, perfumer2), /vault approver must confirm/);
  await assert.rejects(() => review.confirm(b.ob, { signAs: 'APPROVER' }, perfumer), /cannot sign as/);
  const c = await review.confirm(b.ob, {}, approver);
  assert.equal(c.status, 'CONFIRMED');
  const g = await s`select relationship_type from inventory.batch_genealogy_history where oil_batch_id = ${b.ob}`;
  assert.deepEqual(g.map((r) => r.relationship_type), ['QC_REVIEW_DOWNGRADE']);
  const h = (await s`select reason from inventory.lot_hold where subject_type = 'OIL_BATCH' and subject_id = ${b.ob} and released_dt is null`)[0]!;
  assert.match(String(h.reason), /downgraded to Industrial grade/);
  d = await review.detail(b.ob);
  assert.equal(d.decision!.status, 'CONFIRMED');
  await assert.rejects(() => review.confirm(b.ob, {}, perfumer2), /already confirmed/);
});

test('review: reject opens a CAPA; a proposal can be withdrawn by its proposer only; a batch not in review is refused', async () => {
  const s = sql();
  const b = await reviewBatch('Reject accord');
  await review.propose(b.ob, { outcome: 'REJECT', reason: 'wrong profile', signAs: 'APPROVER' }, approver);
  await assert.rejects(() => review.withdraw(b.ob, { reason: 'x' }, perfumer), /Only the person who proposed/);
  await review.withdraw(b.ob, { reason: 'wanted a retest first' }, approver);
  assert.equal((await review.detail(b.ob)).withdrawn.length, 1);
  await review.propose(b.ob, { outcome: 'REJECT', reason: 'wrong profile' }, approver);
  const c = await review.confirm(b.ob, {}, perfumer);
  assert.ok(c.capaId);
  assert.equal((await s`select status from quality.qc_capa where qc_capa_id = ${c.capaId}`)[0]!.status, 'OPEN');
  const g = await s`select relationship_type from inventory.batch_genealogy_history where oil_batch_id = ${b.ob}`;
  assert.deepEqual(g.map((r) => r.relationship_type), ['QC_REVIEW_REJECT']);

  const ok = randomUUID();
  const set = String((await s`select qc_checkpoint_set_id from quality.qc_checkpoint_set where product_id = ${b.productId}`)[0]!.qc_checkpoint_set_id);
  await s`insert into production.oil_batch_master (oil_batch_id, batch_number) values (${ok}, 'APPROVED-1')`;
  await s`insert into quality.batch_qc_round (oil_batch_id, round_no, qc_checkpoint_set_id, inspector_id, results, decision, reasons, policy_version) values (${ok}, 1, ${set}, 'qc', '{}'::jsonb, 'APPROVE', '[]'::jsonb, 1)`;
  await assert.rejects(() => review.propose(ok, { outcome: 'REJECT', reason: 'x' }, perfumer), /not in review/);
});

test('review: reblending names a receiving batch of the same formula that is not on hold', async () => {
  const s = sql();
  const b = await reviewBatch('Reblend accord');
  await review.setReblendRule(b.formulaId, { reblendAllowed: true, maxSharePct: 5, reason: 'ok at 5%' }, approver);
  await assert.rejects(() => review.propose(b.ob, { outcome: 'REBLEND', reason: 'fold', reblendShareBps: 300, reblendIntoOilBatchId: b.ob }, perfumer), /into itself/);
  const into = randomUUID();
  await s`insert into production.oil_batch_master (oil_batch_id, batch_number) values (${into}, 'RECV-1')`;
  await review.propose(b.ob, { outcome: 'REBLEND', reason: 'fold at 3%', reblendShareBps: 300, reblendIntoOilBatchId: into }, perfumer);
  await review.confirm(b.ob, {}, approver);
  const g = await s`select oil_batch_id::text as id, relationship_type from inventory.batch_genealogy_history where oil_batch_id in (${b.ob}, ${into}) order by relationship_type`;
  assert.deepEqual(g.map((r) => [r.id, r.relationship_type]), [[b.ob, 'QC_REVIEW_REBLEND'], [into, 'REBLEND_RECEIVED']]);
});
