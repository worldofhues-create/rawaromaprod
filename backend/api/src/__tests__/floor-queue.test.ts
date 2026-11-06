/**
 * PROD-A-6 — the floor queue (production-floor plan §5, §12.3): strict alternation New/Delayed with
 * New first, FIFO within New, most overdue first within Delayed; expedite and the floor.queue
 * policy above it; stock readiness; HOLD when the policy cannot answer.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rankQueue, alternate, daysLate, FloorQueueService, type QueueJob } from '../floor/floor-queue.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

const NOW = new Date('2026-11-05T12:00:00Z');
const job = (no: string, over: Partial<QueueJob> = {}): QueueJob => ({
  floorJobId: no, jobNo: no, stage: 'PICK', orderRef: null, tote: null, promiseDt: null, createdDt: '2026-11-01T00:00:00Z',
  expedite: false, channel: null, customerTier: null, ready: true, waitingOn: [], ...over,
});
const alt = () => ({ value: { mode: 'alternate' }, explain: 'No rule matched → otherwise', version: 1 });

test('alternate(): New first, then strictly alternating, the longer lane runs on', () => {
  assert.deepEqual(alternate(['n1', 'n2', 'n3'], ['d1']), ['n1', 'd1', 'n2', 'n3']);
  assert.deepEqual(alternate(['n1'], ['d1', 'd2', 'd3']), ['n1', 'd1', 'd2', 'd3']);
  assert.deepEqual(alternate([], ['d1', 'd2']), ['d1', 'd2']);
});

test('daysLate: none without a promise or before it; at least 1 once past it', () => {
  assert.equal(daysLate(null, NOW), 0);
  assert.equal(daysLate('2026-11-06T00:00:00Z', NOW), 0);
  assert.equal(daysLate('2026-11-05T11:00:00Z', NOW), 1);
  assert.equal(daysLate('2026-11-01T12:00:00Z', NOW), 4);
});

test('strict alternation: FIFO within New, most overdue first within Delayed', () => {
  const r = rankQueue([
    job('N-late-made', { createdDt: '2026-11-03T00:00:00Z' }),
    job('D-2', { promiseDt: '2026-11-03T12:00:00Z' }),
    job('N-first-made', { createdDt: '2026-11-01T00:00:00Z' }),
    job('D-9', { promiseDt: '2026-10-27T12:00:00Z' }),
    job('N-mid', { createdDt: '2026-11-02T00:00:00Z' }),
  ], NOW, alt);
  assert.deepEqual(r.map((j) => j.jobNo), ['N-first-made', 'D-9', 'N-mid', 'D-2', 'N-late-made']);
  assert.deepEqual(r.map((j) => j.position), [1, 2, 3, 4, 5]);
  assert.equal(r[1]!.lane, 'DELAYED');
  assert.match(r[1]!.why, /Delayed 9 day/);
});

test('expedite sits above everything; a policy "top" sits above alternation', () => {
  const r = rankQueue([
    job('N1'), job('D1', { promiseDt: '2026-11-01T00:00:00Z' }), job('TRADE', { customerTier: 'trade', promiseDt: '2026-11-01T00:00:00Z' }), job('EXP', { expedite: true, createdDt: '2026-11-04T00:00:00Z' }),
  ], NOW, (j) => (j.customerTier === 'trade' ? { value: { priority: 'top' }, explain: 'Rule 1: customer_tier = trade', version: 2 } : alt()));
  assert.deepEqual(r.map((j) => j.jobNo), ['EXP', 'TRADE', 'N1', 'D1']);
  assert.equal(r[1]!.priority, 'TOP');
  assert.equal(r[1]!.policyVersion, 2);
});

test('stock readiness: a waiting job says what it waits on and the next ready job is pulled ahead', () => {
  const r = rankQueue([job('N1', { ready: false, waitingOn: ['YELLOW-0417'] }), job('N2', { createdDt: '2026-11-02T00:00:00Z' })], NOW, alt);
  assert.deepEqual(r.map((j) => j.jobNo), ['N2', 'N1']);
  assert.match(r[1]!.why, /^Waiting on YELLOW-0417/);
});

test('HOLD: a job the policy cannot answer is not ranked by a guess', () => {
  const r = rankQueue([job('N1'), job('N2')], NOW, (j) => (j.jobNo === 'N2' ? null : alt()));
  assert.equal(r[0]!.jobNo, 'N1');
  assert.equal(r[1]!.priority, 'HOLD');
  assert.equal(r[1]!.position, null);
});

/* ── against the database: the seeded policy, readiness from real lots, an override ──── */

before(ensureSchema);
after(closeTestClient);

test('queue on the DB: default floor.queue is alternation; readiness reads real lots; a one-job override lifts it', async () => {
  const sql = testClient();
  const policies = new PolicyService(sql);
  const codes = new FloorCodeService(sql);
  const svc = new FloorQueueService(sql, policies, codes);
  const admin = principal({ roles: ['admin'] });
  const t = crypto.randomUUID().slice(0, 6);
  const colour = Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  await codes.setFamily({ familyCode: `q_${t}`, familyName: 'Q', colourName: colour, colourHex: '#123456' }, admin);
  const mat = crypto.randomUUID();
  await sql`insert into masterdata.material (material_id, material_code, material_name) values (${mat}, ${'Q-' + t}, 'q')`;
  const fc = await codes.assignCode(mat, `q_${t}`, admin);
  const mk = async (no: string, promise: string | null) => {
    const id = crypto.randomUUID();
    await sql`insert into production.floor_job (floor_job_id, job_no, production_order_id, material_pick_list_id, promise_dt)
      values (${id}, ${no}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${promise})`;
    await sql`insert into production.floor_line (floor_job_id, material_pick_list_item_id, material_id, seq, target_mg) values (${id}, ${crypto.randomUUID()}, ${mat}, 1, 1000)`;
    return id;
  };
  const a = await mk(`QA-${t}`, null);
  const b = await mk(`QB-${t}`, '2020-01-01T00:00:00Z');
  const mine = (q: Awaited<ReturnType<typeof svc.queue>>) => q.items.filter((i) => i.jobNo.endsWith(t));
  let q = await svc.queue('PICK');
  assert.ok(mine(q).every((i) => !i.ready && i.waitingOn.includes(fc.code)), 'no released lot yet: both wait on the code');
  // a released lot of 1 g makes both ready
  const rb = crypto.randomUUID(), ib = crypto.randomUUID();
  await sql`insert into platform.uom_master (uom_id, uom_code, uom_name) values (${crypto.randomUUID()}, 'g', 'gram') on conflict do nothing`;
  const [g] = await sql`select uom_id from platform.uom_master where uom_code = 'g'`;
  await sql`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number) values (${rb}, ${mat}, ${'QL-' + t})`;
  await sql`insert into quality.qc_inspections (rm_batch_id, overall_result) values (${rb}, 'PASS')`;
  await sql`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, quantity_on_hand, uom_id) values (${ib}, ${rb}, ${mat}, 1, ${g!.uom_id})`;
  q = await svc.queue('PICK');
  // Other tests leave jobs on the floor, so the global interleave is checked by the pure tests above;
  // here: the lanes read from the real promise dates, and the default rule answered.
  const lane = (id: string) => mine(q).find((i) => i.floorJobId === id)!;
  assert.equal(lane(a).lane, 'NEW');
  assert.equal(lane(b).lane, 'DELAYED');
  assert.equal(lane(b).priority, 'ALTERNATE');
  assert.ok(mine(q).every((i) => i.ready));
  // an admin override on one job (record_type floor_job) sends it to the top
  await policies.override('floor.queue', 'floor_job', `QB-${t}`, { priority: 'top' }, 'customer escalation', admin);
  q = await svc.queue('PICK');
  const qb = mine(q).find((i) => i.floorJobId === b)!;
  assert.equal(qb.priority, 'TOP');
  assert.match(qb.why, /OVERRIDDEN/);
  assert.ok(q.items.findIndex((i) => i.floorJobId === b) < q.items.findIndex((i) => i.floorJobId === a));
});

test('WALK2-RP-17: the default turn reads as words, never the rule engine trace or "day(s)"', () => {
  const r = rankQueue([job('J-A'), job('J-B', { promiseDt: '2026-11-04T12:00:00Z' })], NOW, () => ({ value: { mode: 'alternate' }, explain: 'No rule matched → otherwise {"mode":"alternate"}', version: 1 }));
  for (const j of r) {
    assert.doesNotMatch(j.why, /No rule matched|\{|day\(s\)/);
    assert.match(j.why, /taken in turn with (new|delayed) jobs/);
  }
  assert.match(r.find((j) => j.jobNo === 'J-B')!.why, /^Delayed 1 day:/);
});

