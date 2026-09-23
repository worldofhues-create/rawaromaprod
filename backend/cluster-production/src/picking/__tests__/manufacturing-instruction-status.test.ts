/**
 * Security review S1, item 4 — PickingService.resolveManufacturingInstruction. Real Postgres
 * (backend/test-support pattern, TEST_DATABASE_URL=postgres://apple@localhost:5432/
 * rawprod_s1_test via backend/test-support/setup-db.sh).
 *
 * Three server-side changes, all proved here against the SERVICE (not a stubbed FormulaLookup
 * return value — the FormulaLookup stub only needs to prove WHAT it was called with):
 *   1. an order still in PLANNING (not yet released to the floor) is refused — a still-planning
 *      order has no business exposing resolved batch quantities.
 *   2. an order in the active/released state (INPROGRESS) proceeds.
 *   3. the resolution is threaded to the mandatory vault-decrypt audit via `requestId` =
 *      `production_order:<id>` — "who, order, time" all land on one audit row (VaultService
 *      writes the row; this proves PickingService supplies the order correlation into it).
 *
 * The edge-layer permission gate itself (`production:manufacturing_instruction:read`, held
 * only by production/compounding — not owner, not filling) is proved against the real
 * PermissionsGuard + the real seed catalog in backend/api/src/__tests__/ra-roles-invariants.
 * test.ts, and was additionally confirmed against a live server in this lane's manual
 * verification (owner correctly 403s; production/compounding pass).
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { uuidv7 } from '@core/data-kernel';
import type { CodedInstruction, FormulaLookup, ReadContext } from '@ra/cluster-formula';
import { PickingService } from '../picking.service.js';
import { ensureSchema, productionDb, productionSchema, principal, closeTestClient } from '../../../../test-support/db.js';

const { productionOrder } = productionSchema;

let db: ReturnType<typeof productionDb>;
let calls: Array<{ formulaVersionId: string; permittedBatchQuantity: number; ctx: ReadContext }>;
const stubFormula: FormulaLookup = {
  async getFloorView() {
    return null;
  },
  async resolveManufacturingInstruction(formulaVersionId, permittedBatchQuantity, ctx) {
    calls.push({ formulaVersionId, permittedBatchQuantity, ctx });
    const out: CodedInstruction[] = [{ code: 'ING-A001', quantity: 5, uom: 'kg', sequenceNo: 1 }];
    return out;
  },
  async getPickList() {
    return null;
  },
};
let picking: PickingService;

before(async () => {
  await ensureSchema();
  db = productionDb();
  picking = new PickingService(db as any, stubFormula);
});

afterAll(async () => {
  await closeTestClient();
});

async function makeOrder(status: string, formulaVersionId: string | null = uuidv7()): Promise<string> {
  const productionOrderId = uuidv7();
  await db.insert(productionOrder).values({
    productionOrderId,
    formulaVersionId,
    orderQty: '100',
    status,
    createdBy: 'test',
    updatedBy: 'test',
  });
  return productionOrderId;
}

test('item 4: a PLANNING order (not yet released) is refused', async () => {
  calls = [];
  const orderId = await makeOrder('PLANNING');
  const p = principal({ permissions: ['production:manufacturing_instruction:read'] });
  await assert.rejects(
    () => picking.resolveManufacturingInstruction(orderId, p),
    (err: unknown) => {
      assert.ok(err instanceof ForbiddenException);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'the formula lookup must never be reached for a non-active order');
});

test('item 4: an INPROGRESS order (released to the floor) resolves', async () => {
  calls = [];
  const orderId = await makeOrder('INPROGRESS');
  const p = principal({ permissions: ['production:manufacturing_instruction:read'] });
  const result = await picking.resolveManufacturingInstruction(orderId, p);
  assert.equal(result?.length, 1);
  assert.equal(calls.length, 1);
});

test('item 4: an unrecognized/future status (e.g. CANCELLED) fails CLOSED, not open', async () => {
  calls = [];
  const orderId = await makeOrder('CANCELLED');
  const p = principal({ permissions: ['production:manufacturing_instruction:read'] });
  await assert.rejects(() => picking.resolveManufacturingInstruction(orderId, p), (err: unknown) => {
    assert.ok(err instanceof ForbiddenException);
    return true;
  });
});

test('item 4: the resolution is correlated to the production order via requestId (audit "who, order, time")', async () => {
  calls = [];
  const orderId = await makeOrder('INPROGRESS');
  const p = principal({ userId: '00000000-0000-7000-8000-00000000ab12', permissions: ['production:manufacturing_instruction:read'] });
  await picking.resolveManufacturingInstruction(orderId, p);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx.actorId, p.userId, 'actorId (who) must be the caller');
  assert.equal(calls[0]!.ctx.requestId, `production_order:${orderId}`, 'requestId must correlate to the order (order)');
});

test('item 4: an order with no formula version linked returns null (not an error)', async () => {
  const orderId = await makeOrder('INPROGRESS', null);
  const p = principal({ permissions: ['production:manufacturing_instruction:read'] });
  const result = await picking.resolveManufacturingInstruction(orderId, p);
  assert.equal(result, null);
});

test('item 4: an unknown order id 404s', async () => {
  const p = principal({ permissions: ['production:manufacturing_instruction:read'] });
  await assert.rejects(
    () => picking.resolveManufacturingInstruction(uuidv7(), p),
    (err: unknown) => {
      assert.ok(err instanceof NotFoundException);
      return true;
    },
  );
});
