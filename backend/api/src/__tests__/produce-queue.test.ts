/**
 * Lane produce — requirement intake → the ranked PRODUCTION QUEUE → alerts. Real Postgres, the real
 * signed ImporterService path, the real ProduceQueueService and DashboardService.
 *
 *   intake    a Created carrying the new fields (priority object, order_refs, sku, pack_size, qty_kg,
 *             lot_policy) lands with every field stored; a Changed re-ranks it.
 *   ordering  priority.rank, then needed_by, then arrival — never re-ranked by RawProd.
 *   alerts    a high-value (₹25,000+) requirement and one already past its need-by date each raise
 *             ONE alert (feed + email event) on arrival; an open requirement that passes its date
 *             later is raised by the sweep, once; the feed is role-filtered and cursor-paged; the
 *             bell (/v1/alerts) counts them for the factory roles.
 *   counters  open / kg to produce / overdue / high value / blocked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ImporterService } from '../bridge/importer.service.js';
import { sealSecret } from '../bridge/secret-box.js';
import { signBody } from '../bridge/signing.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { ProduceQueueService } from '../../../cluster-production/src/produce/produce-queue.service.js';
import { ensureSchema, bridgeDb, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { productWithSku } from '../../../test-support/produce-fixtures.js';

const SECRET = 'produce-queue-test-secret';
let importer: ImporterService;
let queue: ProduceQueueService;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? randomBytes(32).toString('base64');
  await testClient()`insert into bridge.connector_config (id, enabled, hmac_secret_sealed)
            values ('default', true, ${sealSecret(SECRET)})
            on conflict (id) do update set hmac_secret_sealed = excluded.hmac_secret_sealed`;
  importer = new ImporterService(bridgeDb(), testClient());
  queue = new ProduceQueueService(productionDb());
});
after(async () => { await closeTestClient(); });

function send(env: Record<string, unknown>) {
  const body = JSON.stringify(env);
  return importer.handleAlembicEvent(body, signBody(body, SECRET));
}

function created(sku: string, payload: Record<string, unknown>, id: string = randomUUID()) {
  return {
    id,
    env: {
      event_id: randomUUID(), version: 1, type: 'ProductionRequirementCreated',
      org_id: randomUUID(), correlation_id: randomUUID(), causation_id: null,
      occurred_at: new Date().toISOString(), source: 'alembic',
      aggregate: { type: 'production_requirement', id },
      payload: { requirement_id: id, sku, pack_size: '25 kg', lot_policy: 'fifo', ...payload },
    },
  };
}

test('intake: every new field is stored; the Accepted ack goes back; a Changed re-ranks', async () => {
  const p = await productWithSku();
  const c = created(p.skuCode, {
    priority: { rank: 2, reason: 'fifo', order_value_inr: 12000 }, needed_by: '2099-03-01',
    order_refs: ['SO-A', 'SO-B'], qty_kg: 50,
  });
  assert.equal((await send(c.env)).body.outcome, 'applied');
  const [row] = await testClient()`select mapped_sku, qty::float, uom, qty_kg::float, pack_size, priority, priority_rank, priority_reason,
                                          order_value_inr::float, order_refs, order_ref, lot_policy, lifecycle_status
                                     from bridge.production_requirement where alembic_requirement_id = ${c.id}`;
  assert.deepEqual({ ...row }, {
    mapped_sku: p.skuCode, qty: 50, uom: 'kg', qty_kg: 50, pack_size: '25 kg', priority: 'fifo', priority_rank: 2,
    priority_reason: 'fifo', order_value_inr: 12000, order_refs: ['SO-A', 'SO-B'], order_ref: 'SO-A', lot_policy: 'fifo',
    lifecycle_status: 'ACCEPTED',
  });
  const ack = await testClient()`select type from bridge.outbox where aggregate_id = ${c.id}`;
  assert.deepEqual(ack.map((a) => a.type), ['ProductionRequirementAccepted']);
  // Not high value, not overdue → no alert.
  assert.equal((await testClient()`select 1 from production.produce_alert where ref_id = ${c.id}`).length, 0);

  const changed = {
    ...c.env, event_id: randomUUID(), version: 2, type: 'ProductionRequirementChanged',
    payload: { requirement_id: c.id, priority: { rank: 1, reason: 'promised_date', order_value_inr: 12000 } },
  };
  assert.equal((await send(changed)).body.outcome, 'applied');
  const [after] = await testClient()`select priority_rank, priority_reason from bridge.production_requirement where alembic_requirement_id = ${c.id}`;
  assert.deepEqual({ ...after }, { priority_rank: 1, priority_reason: 'promised_date' });
});

test('intake: a malformed new field is a permanent 400 and records nothing', async () => {
  const c = created('ANY-SKU', { priority: { rank: 1, reason: 'vip', order_value_inr: 1 }, needed_by: '2099-01-01', order_refs: ['SO-X'], qty_kg: 5 });
  const r = await send(c.env);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'BRIDGE_PERMANENT_INVALID_PAYLOAD');
  assert.match(String(r.body.detail), /priority:invalid/);
  assert.equal((await testClient()`select 1 from bridge.production_requirement where alembic_requirement_id = ${c.id}`).length, 0);
});

test('queue: ranked by priority.rank, then needed_by, then arrival', async () => {
  const p = await productWithSku();
  const a = created(p.skuCode, { priority: { rank: 5, reason: 'fifo', order_value_inr: 100 }, needed_by: '2099-01-10', order_refs: ['SO-1'], qty_kg: 10 });
  const b = created(p.skuCode, { priority: { rank: 1, reason: 'high_value', order_value_inr: 90000 }, needed_by: '2099-06-01', order_refs: ['SO-2'], qty_kg: 20 });
  const c = created(p.skuCode, { priority: { rank: 5, reason: 'fifo', order_value_inr: 100 }, needed_by: '2099-01-05', order_refs: ['SO-3'], qty_kg: 30 });
  const d = created(p.skuCode, { priority: { rank: 5, reason: 'fifo', order_value_inr: 100 }, needed_by: '2099-01-05', order_refs: ['SO-4'], qty_kg: 40 });
  for (const x of [a, b, c, d]) assert.equal((await send(x.env)).body.outcome, 'applied');
  const { items } = await queue.queue(500);
  const mine = items.filter((i) => [a.id, b.id, c.id, d.id].includes(i.alembicRequirementId)).map((i) => i.alembicRequirementId);
  assert.deepEqual(mine, [b.id, c.id, d.id, a.id], 'rank 1 first; among rank 5 the earlier need-by; equal need-by → arrival order');
  const bRow = items.find((i) => i.alembicRequirementId === b.id)!;
  assert.equal(bRow.highValue, true);
  assert.equal(bRow.stage, 'TO_PLAN');
  assert.equal(bRow.qtyKg, 20);
  assert.deepEqual(bRow.orderRefs, ['SO-2']);
});

test('alerts: a high-value arrival and an overdue arrival each alert once; the sweep catches one that goes overdue later', async () => {
  const p = await productWithSku();
  const hv = created(p.skuCode, { priority: { rank: 1, reason: 'fifo', order_value_inr: 25000 }, needed_by: '2099-01-01', order_refs: ['SO-HV'], qty_kg: 5 });
  const late = created(p.skuCode, { priority: { rank: 9, reason: 'fifo', order_value_inr: 10 }, needed_by: '2020-01-01', order_refs: ['SO-LATE'], qty_kg: 5 });
  for (const x of [hv, late]) await send(x.env);
  const alerts = await testClient()`select kind, severity, title, roles, dedupe_key from production.produce_alert where ref_id in (${hv.id}, ${late.id}) order by kind`;
  assert.deepEqual(alerts.map((a) => a.kind), ['high_value_requirement', 'overdue_requirement']);
  assert.ok(alerts.every((a) => (a.roles as string[]).includes('production') && (a.roles as string[]).includes('warehouse')));
  assert.match(String(alerts[0]!.title), new RegExp(p.skuCode));
  // Each alert also queued its email event on the production outbox.
  const mail = await testClient()`select type from production.outbox where type like 'production.produce.%' and payload->>'title' like ${`%${p.skuCode}%`}`;
  assert.equal(mail.length, 2);
  // Re-delivery of the same Created is already_seen — no second alert.
  assert.equal((await send(hv.env)).body.outcome, 'already_seen');

  // An open requirement whose date passes later: the sweep raises it once.
  const soon = created(p.skuCode, { priority: { rank: 3, reason: 'fifo', order_value_inr: 1 }, needed_by: '2099-01-01', order_refs: ['SO-SOON'], qty_kg: 5 });
  await send(soon.env);
  await testClient()`update bridge.production_requirement set needed_by = now() - interval '1 hour' where alembic_requirement_id = ${soon.id}`;
  assert.ok(await queue.sweepOverdue() >= 1);
  await queue.sweepOverdue();
  const swept = await testClient()`select 1 from production.produce_alert where dedupe_key = ${`overdue:${soon.id}`}`;
  assert.equal(swept.length, 1);
});

test('the alert feed is role-filtered and cursor-paged; owner sees all', async () => {
  const p = await productWithSku();
  const hv = created(p.skuCode, { priority: { rank: 1, reason: 'high_value', order_value_inr: 1 }, needed_by: '2099-01-01', order_refs: ['SO-F'], qty_kg: 1 });
  const before = await queue.alerts(principal({ roles: ['owner'] }), null, 1);
  const cursor = before.lastSeq;
  await send(hv.env);
  const warehouse = await queue.alerts(principal({ roles: ['warehouse'] }), cursor, 50);
  assert.ok(warehouse.items.some((a) => a.refId === hv.id && a.kind === 'high_value_requirement'));
  assert.ok((warehouse.lastSeq ?? 0) > (cursor ?? 0));
  const again = await queue.alerts(principal({ roles: ['warehouse'] }), warehouse.lastSeq, 50);
  assert.ok(!again.items.some((a) => a.refId === hv.id), 'the cursor moves past what was shown');
  const admin = await queue.alerts(principal({ roles: ['admin'] }), cursor, 50);
  assert.ok(!admin.items.some((a) => a.refId === hv.id), 'admin is not a factory role');
});

test('the bell (/v1/alerts) counts produce work for the factory roles', async () => {
  const p = await productWithSku();
  const hv = created(p.skuCode, { priority: { rank: 1, reason: 'high_value', order_value_inr: 99999 }, needed_by: '2099-01-01', order_refs: ['SO-BELL'], qty_kg: 1 });
  await send(hv.env);
  const dash = new DashboardService(testClient(), { formulaLabels: async () => ({ versions: [], formulas: [], recent: null }) } as never);
  const prod = await dash.alerts(principal({ roles: ['production'] }));
  assert.ok(prod.alerts.some((a) => a.title === 'High-value orders to produce' && a.count >= 1));
  const admin = await dash.alerts(principal({ roles: ['admin'] }));
  assert.ok(!admin.alerts.some((a) => a.title === 'High-value orders to produce'));
});

test('counters and the formula-needed list', async () => {
  const p = await productWithSku();
  const blocked = created(p.skuCode, { priority: { rank: 1, reason: 'fifo', order_value_inr: 1 }, needed_by: '2099-01-01', order_refs: ['SO-BLK'], qty_kg: 12 });
  await send(blocked.env);
  await testClient()`update bridge.production_requirement set produce_block_reason = 'NO_APPROVED_FORMULA', produce_blocked_at = now()
                      where alembic_requirement_id = ${blocked.id}`;
  const { items, counters } = await queue.queue(500);
  const row = items.find((i) => i.alembicRequirementId === blocked.id)!;
  assert.equal(row.stage, 'BLOCKED');
  assert.equal(row.blockMessage, 'No approved formula for this product in the Vault — a formulator must seal and approve one');
  assert.ok(counters.blocked >= 1 && counters.open >= 1 && counters.kgToProduce >= 12);
  const needs = await queue.formulaNeeds();
  const mine = needs.find((n) => n.productCode === p.productCode)!;
  assert.ok(mine, 'the product is on the Vault console\'s formula-needed list');
  assert.deepEqual(mine.skuCodes, [p.skuCode]);
  assert.equal(mine.requirementCount, 1);
});
