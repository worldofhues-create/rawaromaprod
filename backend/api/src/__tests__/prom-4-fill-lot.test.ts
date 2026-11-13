/**
 * PROM-4 (LD-85, ALEMBIC docs/plan/program/process-promises.md P-02, S-09): "Every pack carries a lot
 * number tied to its batch record" is made true by the server. Real Postgres; the real packaging and
 * production batch services, the policy service and the fg.batch.received builder.
 *
 *   - a typed finished-good lot is refused ("The lot is assigned at fill"); a fill mints FG-<yymm>-<n>,
 *     marks it as minted at fill and records the rule version;
 *   - a typed oil-batch number is refused; off the floor the server mints OB-<yymm>-<n>; the floor's own
 *     B-<yymm>-<job> is the only number handed in;
 *   - `fill.lot_server_assigned` is data with one valid value: publishing `required: false` is refused,
 *     and there is no single-record override;
 *   - fg.batch.received carries the lot's label record (label_applied_at, lot_assigned_at_fill), ALEMBIC's
 *     own parser accepts it, an older shape still parses, and no formula content crosses (D-1).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { BatchService as PackagingBatchService } from '../../../cluster-packaging/src/batch/batch.service.js';
import { BatchService as ProductionBatchService } from '../../../cluster-production/src/batch/batch.service.js';
import { ensureSchema, packagingDb, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { parseFgBatchReceived } from '../../../test-support/alembic-fulfil.js';
import { PolicyService, POLICY_KEYS } from '../policy/policy.service.js';
import { buildFgBatchReceived, ShelfTaskService } from '../shelf/shelf-task.service.js';
import { shelfDb } from '../shelf/shelf.tokens.js';
import { ShelfLayoutService } from '../shelf/shelf-layout.service.js';
import { PickLightService } from '../shelf/pick-light.service.js';
import { FACTORY_ENFORCEMENT_VERSION, FACTORY_RULE_DEFAULTS, lotRuleProblems } from '@core/backend-kernel';
import { bridge } from '@core/contracts';

let fg: PackagingBatchService, oil: ProductionBatchService, policy: PolicyService;
const op = principal();
const editor = () => principal({ userId: randomUUID(), roles: ['admin'], permissions: ['platform:policy:write'], authTime: Math.floor(Date.now() / 1000) } as never);

before(async () => {
  await ensureSchema();
  fg = new PackagingBatchService(packagingDb());
  oil = new ProductionBatchService(productionDb());
  policy = new PolicyService(testClient());
});
after(async () => closeTestClient());

async function fillingOrder() {
  const id = randomUUID();
  await testClient()`insert into packaging.package_order (package_order_id, status) values (${id}, 'IN_PROGRESS')`;
  return id;
}

test('a typed finished-good lot is refused: the lot is assigned at fill', async () => {
  const packageOrderId = await fillingOrder();
  await assert.rejects(
    () => fg.produceFinishedGoodBatch({ packageOrderId, productSkuId: randomUUID(), batchNumber: 'FG-TYPED-1', producedQty: 4 }, op),
    (e: unknown) => e instanceof BadRequestException && /The lot is assigned at fill/.test((e as Error).message),
  );
  const [n] = await testClient()`select count(*)::int as n from packaging.finished_good_batch_master where package_order_id = ${packageOrderId}`;
  assert.equal(n!.n, 0, 'nothing was written for the refused fill');
});

test('a fill mints the lot from the sequence, marks it minted at fill, and records the rule version', async () => {
  const a = await fg.produceFinishedGoodBatch({ packageOrderId: await fillingOrder(), productSkuId: randomUUID(), producedQty: 4 }, op);
  const b = await fg.produceFinishedGoodBatch({ packageOrderId: await fillingOrder(), productSkuId: randomUUID(), producedQty: 4 }, op);
  const yymm = new Date().toISOString().slice(2, 7).replace('-', '');
  for (const r of [a, b]) assert.match(String(r.batch.batchNumber), new RegExp(`^FG-${yymm}-\\d{5,}$`));
  assert.notEqual(a.batch.batchNumber, b.batch.batchNumber, 'two fills never share a lot');
  const [row] = await testClient()`select lot_assigned_at_fill, lot_rule_version from packaging.finished_good_batch_master where finished_good_batch_id = ${a.batch.finishedGoodBatchId}`;
  assert.equal(row!.lot_assigned_at_fill, true);
  assert.equal(row!.lot_rule_version, 1, 'v1 of fill.lot_server_assigned, published by the migration');
  const [ev] = await testClient()`select payload from packaging.outbox where aggregate_id = ${a.batch.finishedGoodBatchId} and type = 'packaging.fg_batch.created'`;
  assert.equal((ev!.payload as { batchNumber: string }).batchNumber, a.batch.batchNumber, 'the event names the minted lot');
});

test('a typed oil-batch number is refused; off the floor the server mints OB-; the floor hands in its own B-', async () => {
  await assert.rejects(
    () => oil.produceOilBatch({ productionOrderId: randomUUID(), batchNumber: 'TYPED-OIL', producedQty: 5 }, op),
    (e: unknown) => e instanceof BadRequestException && /assigned by the server/.test((e as Error).message),
  );
  const yymm = new Date().toISOString().slice(2, 7).replace('-', '');
  const minted = await oil.produceOilBatch({ productionOrderId: randomUUID(), producedQty: 5 }, op);
  assert.match(String(minted.batch.batchNumber), new RegExp(`^OB-${yymm}-\\d{5,}$`));
  const floor = await oil.produceOilBatch({ productionOrderId: randomUUID(), producedQty: 5 }, op, { batchNumber: `B-${yymm}-0042`, by: 'floor_station' });
  assert.equal(floor.batch.batchNumber, `B-${yymm}-0042`);
  await assert.rejects(() => oil.produceOilBatch({ productionOrderId: randomUUID(), producedQty: 5 }, op, { batchNumber: 'anything I like', by: 'floor_station' }),
    /is not B-<yymm>-<job>/);
});

test('fill.lot_server_assigned is data with one valid value, no record override, enforcement v1', async () => {
  assert.ok((POLICY_KEYS as readonly string[]).includes('fill.lot_server_assigned'));
  assert.deepEqual(FACTORY_RULE_DEFAULTS['fill.lot_server_assigned'], { required: true });
  assert.equal(FACTORY_ENFORCEMENT_VERSION['fill.lot_server_assigned'], 1);
  assert.deepEqual(lotRuleProblems({ required: true }), []);
  assert.equal(lotRuleProblems({ required: false }).length, 1);
  await assert.rejects(
    () => policy.publish('fill.lot_server_assigned', { rules: [], hasDefault: true, defaultValue: { required: false } }, 'try to switch the lot rule off', editor()),
    (e: unknown) => e instanceof BadRequestException && /cannot be switched off/.test((e as Error).message),
  );
  await assert.rejects(
    () => policy.override('fill.lot_server_assigned', 'fill', randomUUID(), { required: false }, 'one batch only', principal({ roles: ['admin'] })),
    /no single-record override/,
  );
  // A stale sign-in cannot save it either, even with the valid value.
  const stale = principal({ userId: randomUUID(), roles: ['admin'], authTime: Math.floor(Date.now() / 1000) - 3600 } as never);
  await assert.rejects(() => policy.publish('fill.lot_server_assigned', { rules: [], hasDefault: true, defaultValue: { required: true } }, 'resave', stale), /Sign in again/);
});

test('fg.batch.received carries the lot label record; ALEMBIC parses it; an older shape still parses; no formula content', () => {
  const base = { batchNo: 'FG-2611-00042', sku: 'RAC-AMB-25KG', packSize: '25 kg', qty: 4, uomCode: 'DRUM', rack: 'R01-S2-B3', releasedAt: '2026-11-02T09:30:00.000Z', qcBatchNo: 'B-2611-0042', compounded: true };
  const full = buildFgBatchReceived({ ...base, labelAppliedAt: '2026-11-03T10:00:00.000Z', lotAssignedAtFill: true });
  assert.ok(full.ok);
  assert.equal(full.payload.label_applied_at, '2026-11-03T10:00:00.000Z');
  assert.equal(full.payload.lot_assigned_at_fill, true);
  assert.deepEqual(bridge.validateFgBatchReceived(full.payload), []);
  assert.doesNotThrow(() => bridge.assertNoFormulaContent(full.payload));
  const parsed = parseFgBatchReceived(full.payload);
  assert.ok(parsed.ok);
  assert.equal(parsed.fact.labelAppliedAt, '2026-11-03T10:00:00.000Z');
  assert.equal(parsed.fact.lotAssignedAtFill, true);

  // No label yet: the field is absent, never back-filled, and ALEMBIC reads null.
  const unlabelled = buildFgBatchReceived({ ...base, labelAppliedAt: null, lotAssignedAtFill: false });
  assert.ok(unlabelled.ok);
  assert.equal('label_applied_at' in unlabelled.payload, false);
  const p2 = parseFgBatchReceived(unlabelled.payload);
  assert.ok(p2.ok && p2.fact.labelAppliedAt === null && p2.fact.lotAssignedAtFill === false);

  // An older sender (no PROM-4 fields) still parses, with both null.
  const old = buildFgBatchReceived(base);
  assert.ok(old.ok);
  const p3 = parseFgBatchReceived(old.payload);
  assert.ok(p3.ok && p3.fact.labelAppliedAt === null && p3.fact.lotAssignedAtFill === null);

  // A malformed label time is refused on both sides.
  assert.deepEqual(bridge.validateFgBatchReceived({ ...full.payload, label_applied_at: 'yesterday' }), ['label_applied_at']);
  assert.equal(parseFgBatchReceived({ ...full.payload, label_applied_at: 'yesterday' }).ok, false);
});

test('the batch record the receipt is built from reads the minted lot and its first applied label', async () => {
  const made = await fg.produceFinishedGoodBatch({ packageOrderId: await fillingOrder(), productSkuId: randomUUID(), producedQty: 4 }, op);
  const id = String(made.batch.finishedGoodBatchId);
  const db = shelfDb(testClient());
  const shelf = new ShelfTaskService(db, new ShelfLayoutService(db), new PickLightService(db));
  let info = await shelf.fgBatch(id);
  assert.equal(info.lotAssignedAtFill, true);
  assert.equal(info.labelAppliedAt, null, 'no label yet: null, never a guessed time');
  await testClient()`insert into packaging.fg_label_record (finished_good_batch_id, label_count, label_content, applied_by, applied_dt, status)
    values (${id}, 4, '{}'::jsonb, ${op.userId}, '2026-11-03T10:00:00Z', 'APPLIED')`;
  info = await shelf.fgBatch(id);
  assert.equal(info.labelAppliedAt, '2026-11-03T10:00:00.000Z');
});
