/**
 * Lane F5 (RP-DEADTABLES) — DispatchDocsService (backend/api/src/dispatchdocs/dispatchdocs.
 * service.ts): list/create used to query/insert sales.dispatch_document, a table that does NOT
 * exist in @ra/data-sales (db:push's only source for the `sales` schema, per
 * scripts/db-schema-groups.ts) nor the Phase-1A Data Dictionary. Both now throw
 * NotImplementedException instead of a 500 against any real database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, NotImplementedException } from '@nestjs/common';
import { DispatchDocsService } from '../dispatchdocs/dispatchdocs.service.js';
import { principal } from '../../../test-support/db.js';

const svc = new DispatchDocsService();

test('dispatch-documents (lane F5): list is honest "not available" — sales.dispatch_document does not exist', async () => {
  await assert.rejects(() => svc.list(200), NotImplementedException);
});

test('dispatch-documents (lane F5): create is honest "not available", not a fabricated row', async () => {
  await assert.rejects(
    () => svc.create({ dispatchId: crypto.randomUUID(), documentType: 'INVOICE' }, principal({ permissions: ['sales:dispatch_master:write'] })),
    NotImplementedException,
  );
});

test('dispatch-documents (lane F5): create still enforces the write permission first', async () => {
  await assert.rejects(
    () => svc.create({ dispatchId: crypto.randomUUID(), documentType: 'INVOICE' }, principal({ permissions: [] })),
    ForbiddenException,
  );
});
