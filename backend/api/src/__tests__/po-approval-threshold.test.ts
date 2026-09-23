/**
 * RP-FAC2 / §87 (lane F8, rp-policy) — purchase-order approval-threshold second level
 * (PoService.approvePurchaseOrder, backend/cluster-procurement/src/po/po.service.ts). The
 * threshold is now CONFIGURABLE per organisation via iam.approval_matrix (policy_type =
 * PO_APPROVAL_THRESHOLD), resolved from the PO creator's iam.user_master.organization_id — the
 * hardcoded ₹5,00,000 default (RP-FAC2/§28) is gone. Below a CONFIGURED threshold one approval is
 * enough; at/above it, a SECOND, DIFFERENT approver is required before the PO reaches APPROVED —
 * the first approval only reaches PENDING_L2_APPROVAL. When NO threshold is configured for the
 * organisation, the current single-approval path applies regardless of amount (never a silent
 * auto-approve — a real, non-creator approver is still always required). Covers: configured
 * below-threshold happy path, configured above-threshold requires two approvals, unconfigured
 * organisation (large PO still only needs one approval, never auto-approved to a phantom
 * threshold), the same approver cannot give both, the creator can never approve (segregation of
 * duties, either level), invalid transitions (approving twice, issuing before APPROVED), and
 * duplicate/concurrent approval on the same PO. Also covers the generic-editor status bypass
 * being closed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PoService } from '../../../cluster-procurement/src/po/po.service.js';
import { EditService } from '../edit/edit.service.js';
import { ensureSchema, procurementDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: PoService;
let editSvc: EditService;

const CREATOR = '00000000-0000-7000-8000-000000000001';
const APPROVER_A = '00000000-0000-7000-8000-000000000002';
const APPROVER_B = '00000000-0000-7000-8000-000000000003';

// A second creator, in an organisation that has NO iam.approval_matrix row at all — the
// "unconfigured" case §87 requires: never auto-approved just because a default is missing.
const UNCONFIGURED_CREATOR = '00000000-0000-7000-8000-0000000000f1';

// The configured threshold for CREATOR's organisation (replaces the old hardcoded constant —
// deliberately a different figure so a passing test proves the value is actually READ from
// iam.approval_matrix, not coincidentally matching some remaining hardcoded default).
const CONFIGURED_THRESHOLD = 450000;

before(async () => {
  await ensureSchema();
  svc = new PoService(procurementDb());
  editSvc = new EditService(testClient());

  const sql = testClient();
  const configuredOrgId = randomUUID();
  const unconfiguredOrgId = randomUUID();
  await sql`insert into iam.org_master (organization_id, organization_name, status) values
    (${configuredOrgId}, 'RP-POLICY configured org', 'ACTIVE'),
    (${unconfiguredOrgId}, 'RP-POLICY unconfigured org', 'ACTIVE')`;
  await sql`insert into iam.user_master (user_id, organization_id, user_name, status) values
    (${CREATOR}, ${configuredOrgId}, 'creator', 'ACTIVE'),
    (${UNCONFIGURED_CREATOR}, ${unconfiguredOrgId}, 'unconfigured-creator', 'ACTIVE')`;
  await sql`insert into iam.approval_matrix
      (organization_id, policy_type, threshold_amount, is_enabled, status)
    values (${configuredOrgId}, 'PO_APPROVAL_THRESHOLD', ${CONFIGURED_THRESHOLD}, true, 'ACTIVE')`;
  // unconfiguredOrgId deliberately gets NO approval_matrix row.
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

test('po approval: below the CONFIGURED threshold, one approval is enough (proves the figure is actually read from iam.approval_matrix)', async () => {
  const id = await freshPo(CONFIGURED_THRESHOLD - 1, { createdBy: CREATOR });
  const { purchaseOrder, requiresSecondLevelApproval } = await svc.approvePurchaseOrder(
    id,
    {},
    principal({ userId: APPROVER_A }),
  );
  assert.equal(requiresSecondLevelApproval, false);
  assert.equal(purchaseOrder.status, 'APPROVED');
});

test('po approval: at the CONFIGURED threshold exactly, a second approval is required', async () => {
  const id = await freshPo(CONFIGURED_THRESHOLD, { createdBy: CREATOR });
  const { requiresSecondLevelApproval } = await svc.approvePurchaseOrder(
    id,
    {},
    principal({ userId: APPROVER_A }),
  );
  assert.equal(requiresSecondLevelApproval, true);
});

test('po approval: §87 unconfigured organisation — a large PO still needs only ONE approval, never auto-approved to a phantom threshold', async () => {
  // UNCONFIGURED_CREATOR's organisation has NO iam.approval_matrix row. A PO far larger than the
  // old hardcoded ₹5,00,000 default (and larger than the OTHER org's configured threshold) must
  // still be approvable by a single authorized, non-creator approver — the "current authorized
  // approval path" §87 requires when no threshold is configured. It must NOT get stuck demanding
  // a second approver that no policy asked for, and it must NOT skip approval altogether.
  const id = await freshPo(10_000_000, { createdBy: UNCONFIGURED_CREATOR });
  const { purchaseOrder, requiresSecondLevelApproval } = await svc.approvePurchaseOrder(
    id,
    {},
    principal({ userId: APPROVER_A }),
  );
  assert.equal(requiresSecondLevelApproval, false);
  assert.equal(purchaseOrder.status, 'APPROVED');
});

test('po approval: §87 unconfigured organisation — the creator STILL cannot approve their own PO (unconfigured never weakens segregation of duties)', async () => {
  const id = await freshPo(10_000_000, { createdBy: UNCONFIGURED_CREATOR });
  await assert.rejects(
    () => svc.approvePurchaseOrder(id, {}, principal({ userId: UNCONFIGURED_CREATOR })),
    ForbiddenException,
  );
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

test('po issue: concurrent issuePurchaseOrder on an APPROVED PO — only one ISSUED transition, one outbox event (security review R1 #6)', async () => {
  // Before the fix, issuePurchaseOrder read the PO, checked status === 'APPROVED', then
  // unconditionally UPDATEd to ISSUED with no compare-and-swap on the WHERE clause (unlike
  // approvePurchaseOrder, which already guards with `and(eq(id, id), eq(status, current))`).
  // Two concurrent issue calls on the same APPROVED PO could both pass the read-time check
  // before either committed, and both proceed to set status = 'ISSUED' and record a
  // `procurement.po.issued` outbox event — a double transition and a duplicate event.
  const id = await freshPo(1000, { createdBy: CREATOR });
  await svc.approvePurchaseOrder(id, {}, principal({ userId: APPROVER_A }));

  const results = await Promise.allSettled([
    svc.issuePurchaseOrder(id, principal({ userId: APPROVER_A })),
    svc.issuePurchaseOrder(id, principal({ userId: APPROVER_A })),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled');
  assert.equal(succeeded.length, 1, 'exactly one concurrent issue should win');
  for (const r of results) {
    if (r.status === 'rejected') assert.ok(r.reason instanceof ConflictException);
  }

  const sql = testClient();
  const rows = await sql`select status from procurement.purchase_order where purchase_order_id = ${id}`;
  assert.equal(rows[0]!.status, 'ISSUED', 'the PO must end up ISSUED exactly once');

  const events = await sql`select id from procurement.outbox
                             where type = 'procurement.po.issued' and aggregate_id = ${id}`;
  assert.equal(events.length, 1, 'exactly one procurement.po.issued outbox event must be recorded, never two');
});
