/**
 * DispatchDocsService (backend/api/src/dispatchdocs/dispatchdocs.service.ts) — lane platform-roles
 * (2026-09-28) restored it: sales.dispatch_document exists on every real database
 * (scripts/migrations/0014), so the Factory "Dispatch docs" screen lists and records documents
 * instead of showing lane F5's refusal. Exercised on a Drizzle-wrapped pool, as in the running API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DispatchDocsService } from '../dispatchdocs/dispatchdocs.service.js';
import { ensureSchema, testClient, principal, closeTestClient, TEST_DATABASE_URL } from '../../../test-support/db.js';

let wrapped: ReturnType<typeof postgres>;
let svc: DispatchDocsService;
const writer = () => principal({ permissions: ['sales:dispatch_master:write'] });

before(async () => {
  await ensureSchema();
  wrapped = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, types: {}, onnotice: () => {} });
  drizzle(wrapped);
  svc = new DispatchDocsService(wrapped as never);
});

after(async () => {
  await wrapped.end({ timeout: 1 });
  await closeTestClient();
});

async function makeDispatch() {
  const sql = testClient();
  const customerId = crypto.randomUUID();
  const salesOrderId = crypto.randomUUID();
  const dispatchId = crypto.randomUUID();
  const soNumber = 'SO-DD-' + dispatchId.slice(0, 8);
  await sql`insert into sales.customer_master (customer_id, customer_name, status) values (${customerId}, 'Doc Customer', 'ACTIVE')`;
  await sql`insert into sales.sales_order (sales_order_id, so_number, customer_id, status) values (${salesOrderId}, ${soNumber}, ${customerId}, 'CONFIRMED')`;
  await sql`insert into sales.dispatch_master (dispatch_id, sales_order_id, customer_id, status) values (${dispatchId}, ${salesOrderId}, ${customerId}, 'DISPATCHED')`;
  return { dispatchId, salesOrderId, soNumber };
}

test('dispatch-documents: an invoice recorded against a real dispatch lists with its SO number and customer', async () => {
  const d = await makeDispatch();
  const created = (await svc.create(
    { dispatchId: d.dispatchId, documentType: 'INVOICE', documentNumber: 'INV-1', documentDate: '2026-09-28', amount: 1234.5 },
    writer(),
  )) as { dispatchDocumentId: string; status: string };
  assert.equal(created.status, 'ISSUED');
  const { items } = await svc.list(500);
  const row = items.find((r) => (r as { dispatchDocumentId: string }).dispatchDocumentId === created.dispatchDocumentId) as Record<string, unknown> | undefined;
  assert.ok(row);
  assert.equal(row!.soNumber, d.soNumber);
  assert.equal(row!.customerName, 'Doc Customer');
  assert.equal(row!.documentDate, '2026-09-28');
  assert.equal(Number(row!.amount), 1234.5);
});

test('dispatch-documents: a proof of delivery is recorded as DELIVERED', async () => {
  const d = await makeDispatch();
  const created = (await svc.create({ dispatchId: d.dispatchId, documentType: 'PROOF_OF_DELIVERY', receivedBy: 'Store manager' }, writer())) as { status: string };
  assert.equal(created.status, 'DELIVERED');
});

test('dispatch-documents: bad input is a 400/404 with plain copy, never a Postgres 500', async () => {
  const d = await makeDispatch();
  await assert.rejects(() => svc.create({ documentType: 'INVOICE' }, writer()), BadRequestException);
  await assert.rejects(() => svc.create({ dispatchId: 'x', documentType: 'INVOICE' }, writer()), BadRequestException);
  await assert.rejects(() => svc.create({ dispatchId: d.dispatchId, documentType: 'RECEIPT' }, writer()), BadRequestException);
  await assert.rejects(() => svc.create({ dispatchId: d.dispatchId, documentType: 'INVOICE', amount: 'lots' }, writer()), BadRequestException);
  await assert.rejects(() => svc.create({ dispatchId: d.dispatchId, documentType: 'INVOICE', documentDate: '28/09/2026' }, writer()), BadRequestException);
  await assert.rejects(() => svc.create({ dispatchId: crypto.randomUUID(), documentType: 'INVOICE' }, writer()), NotFoundException);
});

test('dispatch-documents: create enforces the write permission before touching the database', async () => {
  const noDb = new DispatchDocsService(null as never);
  await assert.rejects(
    () => noDb.create({ dispatchId: crypto.randomUUID(), documentType: 'INVOICE' }, principal({ permissions: [] })),
    ForbiddenException,
  );
});
