/**
 * Lane F5 (RP-DEADTABLES) — AuditService (backend/api/src/audit/audit.service.ts) loginHistory:
 * used to query iam.login_history, a table that exists in NEITHER @core/data-iam nor
 * @ra/data-org (db:push's only sources for the `iam` schema) nor the Phase-1A Data Dictionary.
 * It now throws NotImplementedException instead of a 500 against any real database.
 *
 * formulaAccessAudit (reads formula.audit_events, a real per-schema cross-cutting table built by
 * the @core/data-kernel auditTable() factory) is left untested here: the `formula` schema lives
 * on its own vault connection (scripts/db-schema-groups.ts, vault: true) and is out of this
 * lane's test harness / boundary — see backend/api/src/__tests__/vault-boundary.test.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';

let svc: AuditService;

before(async () => {
  await ensureSchema();
  svc = new AuditService(testClient() as never);
});

after(async () => {
  await closeTestClient();
});

test('login-history (lane F5): honest "not available" — iam.login_history does not exist in @core/data-iam or @ra/data-org', async () => {
  await assert.rejects(() => svc.loginHistory(100), NotImplementedException);
});
