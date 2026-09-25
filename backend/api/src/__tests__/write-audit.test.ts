/**
 * OPS-GREEN (lane ops-factory) — every mutating factory request leaves one audit row in the
 * schema its @Permissions names (write-audit.interceptor.ts), readable through
 * GET /v1/audit-events (AuditService.listAuditEvents). Pure mapping tests + a real-Postgres
 * round trip through the interceptor itself.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lastValueFrom, of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { auditRowFor, WriteAuditInterceptor } from '../audit/write-audit.interceptor.js';
import { AuditService } from '../audit/audit.service.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';

const ID = '01a0d6ce-3657-7000-9854-10d8fd04e505';
const ACTOR = '01a0d6ce-3657-7001-88fd-451dc51eb58c';

test('auditRowFor: the route permission picks the schema and table; :id wins as entity', () => {
  const r = auditRowFor({ method: 'POST', route: '/v1/purchase-orders/:id/approve',
    permissions: ['procurement:purchase_order:write'], params: { id: ID },
    payload: { purchaseOrder: { purchaseOrderId: ID, status: 'APPROVED', vendorName: 'x' } } });
  assert.deepEqual(r, { schema: 'procurement', entityType: 'purchase_order',
    action: 'POST /v1/purchase-orders/:id/approve', entityId: ID, after: { status: 'APPROVED' } });
});

test('auditRowFor: a create finds the table id in the response (top level or one level down)', () => {
  const flat = auditRowFor({ method: 'POST', route: '/v1/uoms', permissions: ['masterdata:uom_master:write'],
    params: {}, payload: { uomMasterId: ID, uomCode: 'KG' } });
  assert.equal(flat?.entityId, ID);
  // `uom_master` answers `uomId`: the `_master` suffix is not part of the id key.
  assert.equal(auditRowFor({ method: 'POST', route: '/v1/uoms', permissions: ['masterdata:uom_master:write'],
    params: {}, payload: { uomId: ID, uomCode: 'KG' } })?.entityId, ID);
  const nested = auditRowFor({ method: 'POST', route: '/v1/production-orders',
    permissions: ['production:production_order:write'], params: {},
    payload: { order: { productionOrderId: ID, status: 'PLANNING' }, ingredientCount: 3 } });
  assert.equal(nested?.entityId, ID);
  assert.deepEqual(nested?.after, { status: 'PLANNING' });
});

test('auditRowFor: reads, unpermissioned routes and unknown schemas', () => {
  assert.equal(auditRowFor({ method: 'GET', route: '/v1/grns', permissions: ['inventory:grn_master:read'], params: {}, payload: {} }), null);
  assert.equal(auditRowFor({ method: 'POST', route: '/auth/login', permissions: undefined, params: {}, payload: {} }), null);
  const other = auditRowFor({ method: 'POST', route: '/v1/geo-regions', permissions: ['location:geo_region:write'], params: {}, payload: {} });
  assert.equal(other?.schema, 'platform');
  assert.equal(other?.entityType, 'location.geo_region');
  // formula is the Vault's hash-chained trail: never written from the main API.
  assert.equal(auditRowFor({ method: 'POST', route: '/v1/x', permissions: ['formula:formula_master:write'], params: {}, payload: {} })?.schema, 'platform');
});

before(async () => { await ensureSchema(); });
after(async () => { await closeTestClient(); });

test('the interceptor writes the row before the response and the governance read returns it', async () => {
  const sql = testClient();
  const reflector = { getAllAndOverride: () => ['procurement:purchase_order:write'] } as unknown as Reflector;
  const interceptor = new WriteAuditInterceptor(reflector, sql);
  const poId = crypto.randomUUID();
  const req = { method: 'POST', routeOptions: { url: '/v1/purchase-orders/:id/issue' }, params: { id: poId },
    user: { userId: ACTOR }, requestId: 'req-audit-test', ip: '127.0.0.1', headers: {} };
  const ctx = {
    getType: () => 'http', getHandler: () => null, getClass: () => null,
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
  const out = await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({ purchaseOrderId: poId, status: 'ISSUED' }) }));
  assert.deepEqual(out, { purchaseOrderId: poId, status: 'ISSUED' });

  const rows = await sql`select actor_id, action, entity_type, entity_id, after, request_id
                           from procurement.audit_events where entity_id = ${poId}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, 'POST /v1/purchase-orders/:id/issue');
  assert.equal(rows[0]!.entity_type, 'purchase_order');
  assert.equal(rows[0]!.actor_id, ACTOR);
  assert.deepEqual(rows[0]!.after, { status: 'ISSUED' });

  const page = await new AuditService(sql).listAuditEvents({ entityId: poId });
  assert.equal(page.items.length, 1);
  assert.equal((page.items[0] as { cluster: string }).cluster, 'procurement');
  assert.equal((page.items[0] as { resultStatus: string }).resultStatus, 'ISSUED');
});
