/**
 * §87 (AUTONOMOUS DECISION DEFAULTS — lane F8/rp-policy) — RFQ award separation of duties
 * (RfqService.selectQuotation, backend/cluster-procurement/src/rfq/rfq.service.ts). Resolves
 * security review R1's informational finding #7 (documented, unresolved, in the pre-existing
 * selectQuotation doc comment): the RFQ's own creator could always award its winning quotation,
 * with no separation-of-duties check at all.
 *
 * Now, CONFIGURABLE per organisation via iam.approval_matrix (policy_type =
 * RFQ_AWARD_SEPARATION, resolved from the RFQ creator's iam.user_master.organization_id):
 *   - unconfigured organisation → separation ENFORCED (conservative default: "separate creator
 *     from final award approver where roles permit").
 *   - configured is_enabled = true → separation ENFORCED.
 *   - configured is_enabled = false → separation NOT enforced (org opt-out).
 * When enforced and the caller is the RFQ's own creator, the award is refused UNLESS the caller
 * supplies a non-empty `overrideReason` AND holds the dedicated
 * `procurement:quotations:award_override` permission — the "only one authorized approver"
 * escape hatch §87 requires, permission-gated, reasoned, and audited (never a silent deadlock,
 * never a silent bypass). Covers all three configuration paths plus the override path itself
 * (denied without permission, denied without a reason, allowed + audited with both).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { RfqService } from '../../../cluster-procurement/src/rfq/rfq.service.js';
import { ensureSchema, procurementDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let rfqs: RfqService;

before(async () => {
  await ensureSchema();
  rfqs = new RfqService(procurementDb());
});

after(async () => {
  await closeTestClient();
});

/**
 * Insert an org (+ optionally an approval_matrix row for RFQ_AWARD_SEPARATION) and a user in it.
 * `orgId` is always a fresh randomUUID() (astronomically unlikely to collide even across repeat
 * runs against a persisted, un-truncated test DB), but every insert still carries
 * `on conflict ... do nothing` as defense-in-depth — the same belt-and-suspenders fix P0's
 * duplicate-key report applied to po-approval-threshold.test.ts, whose FIXED (non-random) ids
 * were the actual root cause there. `userId` is caller-supplied (each test's own randomUUID()),
 * so it gets the same treatment.
 */
async function makeOrgUser(userId: string, isEnabled?: boolean): Promise<void> {
  const sql = testClient();
  const orgId = randomUUID();
  await sql`insert into iam.org_master (organization_id, organization_name, status)
    values (${orgId}, ${'org-' + orgId.slice(0, 8)}, 'ACTIVE')
    on conflict (organization_id) do nothing`;
  await sql`insert into iam.user_master (user_id, organization_id, user_name, status)
    values (${userId}, ${orgId}, 'user', 'ACTIVE')
    on conflict (user_id) do nothing`;
  if (isEnabled !== undefined) {
    await sql`insert into iam.approval_matrix
        (organization_id, policy_type, is_enabled, status)
      values (${orgId}, 'RFQ_AWARD_SEPARATION', ${isEnabled}, 'ACTIVE')
      on conflict (organization_id, policy_type) do nothing`;
  }
}

/** A fresh RFQ + one mapped vendor + one quotation, created by `creatorId`. */
async function freshRfq(creatorId: string) {
  const sql = testClient();
  const rfq = await rfqs.createRfqMaster(
    { purchaseRequestId: crypto.randomUUID(), rfqDate: '2026-01-01' },
    principal({ userId: creatorId }),
  );
  const vendorId = crypto.randomUUID();
  await sql`insert into procurement.vendor_details (vendor_id, vendor_code, vendor_name, status)
    values (${vendorId}, ${'V-' + vendorId.slice(0, 8)}, 'Vendor', 'ACTIVE')`;
  await rfqs.createRfqVendorMapping(
    { rfqId: rfq.rfqId, vendorId, isSelectedVendor: false },
    principal({ userId: creatorId }),
  );
  const quotation = await rfqs.createQuotation(
    { rfqId: rfq.rfqId, vendorId, quotationNumber: 'Q-' + Date.now() + '-' + Math.random() },
    principal({ userId: creatorId }),
  );
  return { rfqId: rfq.rfqId, quotationId: quotation.quotationId, vendorId };
}

test('RFQ award separation: unconfigured organisation — the creator CANNOT award their own RFQ (conservative default)', async () => {
  const creator = randomUUID();
  await makeOrgUser(creator); // no approval_matrix row at all
  const { quotationId } = await freshRfq(creator);
  await assert.rejects(
    () => rfqs.selectQuotation(quotationId, {}, principal({ userId: creator })),
    ForbiddenException,
  );
});

test('RFQ award separation: unconfigured organisation — a DIFFERENT approver can award it', async () => {
  const creator = randomUUID();
  const approver = randomUUID();
  await makeOrgUser(creator);
  const { quotationId } = await freshRfq(creator);
  const awarded = await rfqs.selectQuotation(quotationId, {}, principal({ userId: approver }));
  assert.equal(awarded.status, 'SELECTED');
});

test('RFQ award separation: configured is_enabled=true — the creator still cannot award their own RFQ', async () => {
  const creator = randomUUID();
  await makeOrgUser(creator, true);
  const { quotationId } = await freshRfq(creator);
  await assert.rejects(
    () => rfqs.selectQuotation(quotationId, {}, principal({ userId: creator })),
    ForbiddenException,
  );
});

test('RFQ award separation: configured is_enabled=false — the organisation opted out, the creator MAY award their own RFQ', async () => {
  const creator = randomUUID();
  await makeOrgUser(creator, false);
  const { quotationId } = await freshRfq(creator);
  const awarded = await rfqs.selectQuotation(quotationId, {}, principal({ userId: creator }));
  assert.equal(awarded.status, 'SELECTED');
});

test('RFQ award separation: single-approver override — refused with no overrideReason, even holding the override permission', async () => {
  const creator = randomUUID();
  await makeOrgUser(creator, true);
  const { quotationId } = await freshRfq(creator);
  await assert.rejects(
    () =>
      rfqs.selectQuotation(
        quotationId,
        {},
        principal({ userId: creator, permissions: ['procurement:quotations:award_override'] }),
      ),
    ForbiddenException,
  );
});

test('RFQ award separation: single-approver override — refused with a reason but WITHOUT the override permission', async () => {
  const creator = randomUUID();
  await makeOrgUser(creator, true);
  const { quotationId } = await freshRfq(creator);
  await assert.rejects(
    () =>
      rfqs.selectQuotation(
        quotationId,
        { overrideReason: 'only one authorized approver in this org' },
        principal({ userId: creator, permissions: [] }),
      ),
    ForbiddenException,
  );
});

test('RFQ award separation: single-approver override — allowed with BOTH a reason and the override permission, and audited', async () => {
  const creator = randomUUID();
  await makeOrgUser(creator, true);
  const { rfqId, quotationId } = await freshRfq(creator);
  const reason = 'only one authorized approver in this org';
  const awarded = await rfqs.selectQuotation(
    quotationId,
    { overrideReason: reason },
    principal({ userId: creator, permissions: ['procurement:quotations:award_override'] }),
  );
  assert.equal(awarded.status, 'SELECTED');

  const sql = testClient();
  const events = await sql`select action, entity_type, entity_id, actor_id, after
      from procurement.audit_events
     where action = 'rfq.award.override' and entity_id = ${rfqId}`;
  assert.equal(events.length, 1, 'exactly one audit row for the override');
  assert.equal(events[0]!.actor_id, creator);
  const after = events[0]!.after as { reason?: string; quotationId?: string };
  assert.equal(after.reason, reason);
  assert.equal(after.quotationId, quotationId);
});

test('RFQ award separation: overrideReason of only whitespace is treated as no reason (refused)', async () => {
  const creator = randomUUID();
  await makeOrgUser(creator, true);
  const { quotationId } = await freshRfq(creator);
  await assert.rejects(
    () =>
      rfqs.selectQuotation(
        quotationId,
        { overrideReason: '   ' },
        principal({ userId: creator, permissions: ['procurement:quotations:award_override'] }),
      ),
    ForbiddenException,
  );
});
