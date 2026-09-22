/**
 * Lane F5 (RP-DEADTABLES) — DocumentsService (backend/api/src/documents/documents.service.ts):
 * list/get/create used to query/insert platform.document_registry, a table that exists in
 * NEITHER @core/data-platform nor @ra/data-reference (db:push's only sources for the `platform`
 * schema, per scripts/db-schema-groups.ts) nor the Phase-1A Data Dictionary. All three now throw
 * NotImplementedException instead of a 500 against any real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NotImplementedException } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service.js';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let svc: DocumentsService;

before(async () => {
  await ensureSchema();
  svc = new DocumentsService(testClient() as never);
});

after(async () => {
  await closeTestClient();
});

test('document-registry (lane F5): list is honest "not available" — platform.document_registry does not exist', async () => {
  await assert.rejects(() => svc.list({ limit: 100 }), NotImplementedException);
});

test('document-registry (lane F5): get is honest "not available"', async () => {
  await assert.rejects(() => svc.get(crypto.randomUUID()), NotImplementedException);
});

test('document-registry (lane F5): create is honest "not available", not a fabricated row', async () => {
  await assert.rejects(
    () => svc.create({ title: 'COA' }, principal()),
    NotImplementedException,
  );
});
