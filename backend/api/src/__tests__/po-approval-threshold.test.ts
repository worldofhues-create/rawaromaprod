/**
 * RP-FAC2 — purchase-order approval-threshold second level (PoService.approvePurchaseOrder,
 * backend/cluster-procurement/src/po/po.service.ts, §28). Below PO_APPROVAL_THRESHOLD_AMOUNT one
 * approval is enough (unchanged); at/above it, a SECOND, DIFFERENT approver is required before the
 * PO reaches APPROVED — the first approval only reaches PENDING_L2_APPROVAL. Covers: below-
 * threshold happy path (one approval suffices), above-threshold requires two approvals, the same
 * approver cannot give both, the creator can never approve (segregation of duties, either level),
 * invalid transitions (approving twice, issuing before APPROVED), and duplicate/concurrent
 * approval on the same PO. Also covers the generic-editor status bypass being closed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PoService } from '../../../cluster-procurement/src/po/po.service.js';
import { EditService } from '../edit/edit.service.js';
import { ensureSchema, procurementDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: PoService;
let editSvc: EditService;

const CREATOR = '00000000-0000-7000-8000-000000000001';
const APPROVER_A = '00000000-0000-7000-8000-000000000002';
const APPROVER_B = '00000000-0000-7000-8000-000000000003';

before(async () => {
  await ensureSchema();
  svc = new PoService(procurementDb());
  editSvc = new EditService(testClient());
});

after(async () => {
  await closeTestClient();
});

async function freshPo(amount: number, opts: { createdBy?: string } = {}) {
  const created = await svc.createPurchaseOrder(
    {
      items: [{ materialId: crypto.randomUUID(), orderedQty: 1, rate: amount, amount }],
    },
    principal({ userId: opts.createdBy ?? CREATOR }),
  );
  return created.purchaseOrder.purchaseOrderId;
}

test('po approval: below threshold, ONE approval is enough', async () => {
  const id = await freshPo(1000, { createdBy: CREATOR });
  const { purchaseOrder, requiresSecondLevelApproval } = await svc.approvePurchaseOrder(
    id,
    {},
    principal({ userId: APPROVER_A }),
  );
  assert.equal(requiresSecondLevelApproval, false);
  assert.equal(purchaseOrder.status, 'APPROVED');
});

test('po approval: at/above threshold, the FIRST approval only reaches PENDING_L2_APPROVAL', async () => {
  const id = await freshPo(600000, { createdBy: CREATOR });
  const { purchaseOrder, requiresSecondLevelApproval } = await svc.approvePurchaseOrder(
    id,
    {},
    principal({ userId: APPROVER_A }),
  );
  assert.equal(requiresSecondLevelApproval, true);
  assert.equal(purchaseOrder.status, 'PENDING_L2_APPROVAL');
});

test('po approval: above threshold, a SECOND different approver reaches APPROVED', async () => {
  const id = await freshPo(600000, { createdBy: CREATOR });
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A }));
  const { purchaseOrder } = await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_B }));
  assert.equal(purchaseOrder.status, 'APPROVED');
});

test('po approval: the SAME approver cannot give both levels (segregation of duties)', async () => {
  const id = await freshPo(600000, { createdBy: CREATOR });
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A }));
  await assert.rejects(
    () => svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A })),
    ForbiddenException,
  );
});

test('po approval: the creator can never approve, even the second level (segregation of duties)', async () => {
  const id = await freshPo(600000, { createdBy: CREATOR });
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A }));
  await assert.rejects(
    () => svc.approvePurchaseOrder(id, {}, principal({ userId: CREATOR })),
    ForbiddenException,
  );
});

test('po approval: cannot approve an already-APPROVED PO (invalid transition)', async () => {
  const id = await freshPo(1000, { createdBy: CREATOR });
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A }));
  await assert.rejects(
    () => svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_B })),
    ConflictException,
  );
});

test('po approval: cannot issue a PO stuck in PENDING_L2_APPROVAL', async () => {
  const id = await freshPo(600000, { createdBy: CREATOR });
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A }));
  await assert.rejects(() => svc.issuePurchaseOrder(id, principal({ userId: APPROVER_A })), ConflictException);
});

test('po approval: duplicate/concurrent approval on a single-approval (below-threshold) PO — only one wins', async () => {
  // Below threshold, one approval is terminal (DRAFT -> APPROVED). Two concurrent approvers
  // racing for that single slot must not both succeed — this is the CAS invariant (mirrors the
  // oil-batch / mixing-session / CAPA concurrent-transition tests). At/above threshold, TWO
  // sequential approvals are legitimately both allowed (covered by the happy-path test above) —
  // that is a two-step workflow, not a race, so it is not conflated with this invariant.
  const id = await freshPo(1000, { createdBy: CREATOR });
  const results = await Promise.allSettled([
    svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A })),
    svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_B })),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one concurrent approval should win');
});

test('po approval: a client-supplied approverUserId cannot spoof a second distinct approver (security review R1 #1)', async () => {
  // Repro: APPROVER_A first-approves with a body claiming a DIFFERENT approverUserId (an id
  // that isn't even principal.userId). If the service ever trusted that field, the recorded
  // first approval would belong to the spoofed id, letting APPROVER_A approve again as
  // themselves and single-handedly satisfy the two-distinct-approver rule. The identity must
  // ALWAYS come from principal.userId regardless of what the body claims.
  const id = await freshPo(600000, { createdBy: CREATOR });
  const spoofedId = '00000000-0000-7000-8000-00000000dead';
  await svc.approvePurchaseOrder(
    id,
    { approverUserId: spoofedId } as never,
    principal({ userId: APPROVER_A }),
  );
  // APPROVER_A tries to give the "second" approval themselves — must be refused: the real
  // first approver of record is APPROVER_A (principal-derived), not the spoofed id.
  await assert.rejects(
    () => svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A })),
    ForbiddenException,
  );
  // A genuinely different approver still can, and the PO ends up correctly APPROVED (not
  // stuck, and not approved solely by APPROVER_A).
  const { purchaseOrder } = await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_B }));
  assert.equal(purchaseOrder.status, 'APPROVED');
});

test('po approval: the generic EditService editor can no longer PATCH status directly (bypass closed)', async () => {
  const id = await freshPo(1000, { createdBy: CREATOR });
  const p = principal({ userId: CREATOR, permissions: ['procurement:purchase_order:write'] });
  await assert.rejects(
    () => editSvc.update('purchase-orders', id, { status: 'APPROVED' }, p),
    /No editable fields supplied/,
  );
});
