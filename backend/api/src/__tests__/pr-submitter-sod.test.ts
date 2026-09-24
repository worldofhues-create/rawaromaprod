/**
 * Golden journey lane/j2 — purchase-request segregation of duties for AUTOMATION-drafted PRs.
 *
 * The G3 material-shortage rule drafts PRs as `created_by = 'automation:g3'`, so the existing
 * "creator cannot approve" check never fires for them. Live, the same procurement user
 * submitted AND approved the auto-drafted PR. `approvePurchaseRequest` now also refuses the
 * user who SUBMITTED the PR (recorded on the PENDING approval row), while a different approver
 * still succeeds, and a human-created PR keeps its original creator rule.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { RequirementService } from '../../../cluster-procurement/src/requirement/requirement.service.js';
import { ensureSchema, procurementDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: RequirementService;

before(async () => {
  await ensureSchema();
  svc = new RequirementService(procurementDb());
});
after(async () => {
  await closeTestClient();
});

async function automationDraft(): Promise<string> {
  const id = randomUUID();
  await testClient()`
    insert into procurement.purchase_request (purchase_request_id, pr_number, priority, status, created_by, updated_by)
    values (${id}, ${'PR-AUTO-' + id.slice(0, 8)}, 'NORMAL', 'DRAFT', 'automation:g3', 'automation:g3')`;
  return id;
}

test('PR SoD: the user who SUBMITTED an automation-drafted PR cannot approve it', async () => {
  const submitter = randomUUID();
  const id = await automationDraft();
  await svc.submitPurchaseRequest(id, {}, principal({ userId: submitter }));
  await assert.rejects(
    () => svc.approvePurchaseRequest(id, {}, principal({ userId: submitter })),
    (e: unknown) => e instanceof ForbiddenException && /you submitted this purchase request/.test((e as Error).message),
  );
  const [row] = await testClient()`select status from procurement.purchase_request where purchase_request_id = ${id}`;
  assert.equal(row!.status, 'SUBMITTED', 'refused approval leaves the PR pending');
});

test('PR SoD: a DIFFERENT approver can approve the automation-drafted PR', async () => {
  const id = await automationDraft();
  await svc.submitPurchaseRequest(id, {}, principal({ userId: randomUUID() }));
  const approver = randomUUID();
  const out = await svc.approvePurchaseRequest(id, {}, principal({ userId: approver }));
  assert.equal(out.purchaseRequest.status, 'APPROVED');
  assert.equal(out.purchaseRequest.approvedBy, approver);
});

test('PR SoD: the creator rule still applies to a human-created PR', async () => {
  const creator = randomUUID();
  const pr = await svc.createPurchaseRequest({ prNumber: 'PR-SOD-' + creator.slice(0, 6) }, principal({ userId: creator }));
  await svc.submitPurchaseRequest(pr.purchaseRequestId, {}, principal({ userId: randomUUID() }));
  await assert.rejects(
    () => svc.approvePurchaseRequest(pr.purchaseRequestId, {}, principal({ userId: creator })),
    (e: unknown) => e instanceof ForbiddenException && /you created this purchase request/.test((e as Error).message),
  );
});
