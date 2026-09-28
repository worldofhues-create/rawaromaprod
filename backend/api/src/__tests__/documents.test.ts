/**
 * DocumentsService (backend/api/src/documents/documents.service.ts) — lane platform-roles
 * (2026-09-28) restored it: platform.document_registry exists on every real database
 * (scripts/migrations/0015), so the Factory "Documents" screen lists/creates/versions documents
 * instead of showing lane F5's refusal. Exercised on a Drizzle-wrapped pool, as in the running API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DocumentsService } from '../documents/documents.service.js';
import { ensureSchema, principal, closeTestClient, TEST_DATABASE_URL } from '../../../test-support/db.js';

let wrapped: ReturnType<typeof postgres>;
let svc: DocumentsService;

before(async () => {
  await ensureSchema();
  wrapped = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, types: {}, onnotice: () => {} });
  drizzle(wrapped);
  svc = new DocumentsService(wrapped as never);
});

after(async () => {
  await wrapped.end({ timeout: 1 });
  await closeTestClient();
});

test('document-registry: create, get, and list by entity — with days-to-expiry', async () => {
  const entityId = crypto.randomUUID();
  const doc = (await svc.create(
    { title: 'IFRA certificate', documentType: 'IFRA Certificate', entityType: 'vendor', entityId, expiryDate: '2099-01-01', sourceUrl: 'https://example.com/ifra.pdf' },
    principal(),
  )) as Record<string, unknown>;
  assert.equal(doc.title, 'IFRA certificate');
  assert.equal(doc.version, 1);
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.expiryDate, '2099-01-01');
  assert.ok(Number(doc.daysToExpiry) > 0);
  const { items } = await svc.list({ entityType: 'vendor', entityId });
  assert.equal(items.length, 1);
  assert.equal((await svc.get(String(doc.documentRegistryId)) as Record<string, unknown>).title, 'IFRA certificate');
});

test('document-registry: a new version supersedes the prior one in the same transaction', async () => {
  const v1 = (await svc.create({ title: 'COA', documentType: 'COA' }, principal())) as Record<string, unknown>;
  const v2 = (await svc.create({ title: 'COA', documentType: 'COA', supersedesId: v1.documentRegistryId }, principal())) as Record<string, unknown>;
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedesId, v1.documentRegistryId);
  assert.equal((await svc.get(String(v1.documentRegistryId)) as Record<string, unknown>).status, 'SUPERSEDED');
});

test('document-registry: bad input is a 400/404 with plain copy, never a Postgres 500', async () => {
  await assert.rejects(() => svc.create({ documentType: 'COA' }, principal()), BadRequestException);
  await assert.rejects(() => svc.create({ title: 'x', documentType: 'COA', entityId: 'nope' }, principal()), BadRequestException);
  await assert.rejects(() => svc.create({ title: 'x', documentType: 'COA', entityType: 'planet' }, principal()), BadRequestException);
  await assert.rejects(() => svc.create({ title: 'x', documentType: 'COA', expiryDate: 'soon' }, principal()), BadRequestException);
  await assert.rejects(() => svc.create({ title: 'x', documentType: 'COA', sourceUrl: 'javascript:alert(1)' }, principal()), BadRequestException);
  await assert.rejects(() => svc.create({ title: 'x', documentType: 'COA', supersedesId: crypto.randomUUID() }, principal()), NotFoundException);
  await assert.rejects(() => svc.get('not-a-uuid'), NotFoundException);
  await assert.rejects(() => svc.list({ entityId: 'nope' }), BadRequestException);
});
