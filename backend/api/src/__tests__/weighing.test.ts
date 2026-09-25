/**
 * OPS-GREEN Act L (lane ops-factory) — the WEIGH step. The target comes from the coded
 * instruction (VaultPort), never from the operator; a reading outside tolerance is kept on file
 * as OUT_OF_TOLERANCE and does not count; a mixing session cannot be completed until every
 * instruction line has an ACCEPTED reading. Real Postgres; the Vault port is a stub returning a
 * coded instruction (floor code + quantity only), exactly the shape the real port returns.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { VaultPort } from '@ra/cluster-formula';
import { WeighingService, withinTolerance } from '../../../cluster-production/src/weighing/weighing.service.js';
import { MixingService } from '../../../cluster-production/src/mixing/mixing.service.js';
import { ensureSchema, productionDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

const vault = {
  resolveManufacturingInstruction: async () => [
    { code: 'RX-A', quantity: 0.5, uom: 'kg', sequenceNo: 1 },
    { code: 'RX-B', quantity: 0.25, uom: 'kg', sequenceNo: 2 },
  ],
} as unknown as VaultPort;

let weighing: WeighingService;
let mixing: MixingService;

before(async () => {
  await ensureSchema();
  weighing = new WeighingService(productionDb(), vault);
  mixing = new MixingService(productionDb());
});
after(async () => { await closeTestClient(); });

async function sessionForTwoLineOrder() {
  const sql = testClient();
  const orderId = crypto.randomUUID();
  await sql`insert into production.production_order (production_order_id, formula_version_id, order_qty, status)
            values (${orderId}, ${crypto.randomUUID()}, 0.75, 'INPROGRESS')`;
  for (const q of [0.5, 0.25]) {
    await sql`insert into production.production_order_ingredients
      (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, status)
      values (${crypto.randomUUID()}, ${orderId}, ${crypto.randomUUID()}, ${q}, true, 'PENDING')`;
  }
  const session = await mixing.startSession({ productionOrderId: orderId }, principal());
  return { orderId, sessionId: session.secureMixingSessionId };
}

test('withinTolerance: symmetric percentage band on the target', () => {
  assert.equal(withinTolerance(0.505, 0.5, 1), true);
  assert.equal(withinTolerance(0.4951, 0.5, 1), true);
  assert.equal(withinTolerance(0.506, 0.5, 1), false);
});

test('weigh -> mix: out-of-tolerance is kept but does not count; the session completes only when every line is accepted', async () => {
  const { sessionId } = await sessionForTwoLineOrder();

  // Line 1 in tolerance: target and floor code come from the instruction, net = gross - tare.
  const one = await weighing.recordWeighing(sessionId, { sequenceNo: 1, grossQty: 1.702, tareQty: 1.2 }, principal());
  assert.equal(one.status, 'ACCEPTED');
  assert.equal(one.floorCode, 'RX-A');
  assert.equal(Number(one.targetQty), 0.5);
  assert.equal(Number(one.netQty), 0.502);

  // A second accepted reading for the same line is refused.
  await assert.rejects(() => weighing.recordWeighing(sessionId, { sequenceNo: 1, grossQty: 1.7, tareQty: 1.2 }, principal()), ConflictException);

  // Line 2 out of tolerance: recorded, not accepted; mixing cannot complete.
  const bad = await weighing.recordWeighing(sessionId, { sequenceNo: 2, grossQty: 1.5, tareQty: 1.2 }, principal());
  assert.equal(bad.status, 'OUT_OF_TOLERANCE');
  assert.equal(bad.withinTolerance, false);
  await assert.rejects(() => mixing.endSession(sessionId, {}, principal()), /1 instruction line\(s\) have no accepted weighing/);

  // Re-weigh line 2 in tolerance -> the session now completes.
  const good = await weighing.recordWeighing(sessionId, { sequenceNo: 2, grossQty: 1.4502, tareQty: 1.2 }, principal());
  assert.equal(good.status, 'ACCEPTED');
  const ended = await mixing.endSession(sessionId, {}, principal());
  assert.equal(ended.status, 'COMPLETED');

  const listed = await weighing.list({ limit: 20, sessionId });
  assert.equal(listed.items.length, 3);
  // Floor codes only: no material identity is stored on a weighing.
  assert.ok(listed.items.every((r) => /^RX-/.test(r.floorCode) && !('materialId' in r)));
});

test('weighing refuses an unknown line, a non-positive net, and a session that is not IN_PROGRESS', async () => {
  const { sessionId } = await sessionForTwoLineOrder();
  await assert.rejects(() => weighing.recordWeighing(sessionId, { sequenceNo: 9, grossQty: 1, tareQty: 0.5 }, principal()), BadRequestException);
  await assert.rejects(() => weighing.recordWeighing(sessionId, { sequenceNo: 1, grossQty: 1, tareQty: 1 }, principal()), BadRequestException);
  await mixing.abortSession(sessionId, { reason: 'test' }, principal());
  await assert.rejects(() => weighing.recordWeighing(sessionId, { sequenceNo: 1, grossQty: 1.7, tareQty: 1.2 }, principal()), ConflictException);
});
