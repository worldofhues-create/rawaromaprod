/**
 * FLOOR-FIX-10 (Alembic doc 17 §5.2) — the two signed bridge endpoints, tested THROUGH THE ROUTE:
 * Nest + Fastify + the production raw-body parser + the real controller + the real service. The
 * service tests prove the HMAC logic; these prove the route hands it the exact bytes ALEMBIC signed
 * and returns the status the service decided (a static @HttpCode would turn a 401 into a 200).
 *
 *   POST v1/bridge/alembic/events   signed body: 200 applied; 401 bad signature, tampered, unsigned; 400 malformed
 *   POST v1/bridge/catalogue/sync   signed timestamp.nonce.body: 200; 401 bad signature, stale, replayed; 403 other tenant
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ensureSchema, bridgeDb, testClient, closeTestClient } from '../../../test-support/db.js';
import { installRawJsonParser } from '../raw-json-parser.js';
import { BridgeController } from '../bridge/bridge.controller.js';
import { ImporterService } from '../bridge/importer.service.js';
import { ConfigAdminService } from '../bridge/config-admin.service.js';
import { RequirementsQueueService } from '../bridge/requirements-queue.service.js';
import { OutboxAdminService } from '../bridge/outbox-admin.service.js';
import { FactorySetupController } from '../factory-setup/factory-setup.controller.js';
import { FactoryCatalogueService } from '../factory-setup/catalogue.service.js';
import { FactorySetupService } from '../factory-setup/setup.service.js';
import { SetupStatusService } from '../factory-setup/setup-status.service.js';
import { signBody } from '../bridge/signing.js';
import { sealSecret } from '../bridge/secret-box.js';

const SECRET = 'bridge-routes-test-secret';
const TENANT = '0190f0a1-0000-7000-8000-00000000b17e';
const kekPrior = process.env.BRIDGE_HMAC_KEK;
let app: NestFastifyApplication;
type Inject = (o: unknown) => Promise<{ statusCode: number; payload: string }>;
let inject: Inject;

before(async () => {
  await ensureSchema();
  process.env.BRIDGE_HMAC_KEK = process.env.BRIDGE_HMAC_KEK ?? Buffer.alloc(32, 9).toString('base64');
  const sql = testClient();
  await sql`insert into bridge.connector_config (id, enabled, webhook_url, hmac_secret_sealed)
            values ('default', true, 'https://alembic.example.test/api/v1/bridge/rawprod/events', ${sealSecret(SECRET)})
            on conflict (id) do update set enabled = true, webhook_url = excluded.webhook_url, hmac_secret_sealed = excluded.hmac_secret_sealed`;
  const config = { get: (k: string) => (k === 'ALEMBIC_ASSERTION_TENANT_ID' ? TENANT : undefined) } as never;
  const status = new SetupStatusService(sql);
  @Module({
    controllers: [BridgeController, FactorySetupController],
    providers: [
      { provide: ImporterService, useValue: new ImporterService(bridgeDb(), sql) },
      { provide: ConfigAdminService, useValue: {} },
      { provide: RequirementsQueueService, useValue: {} },
      { provide: OutboxAdminService, useValue: {} },
      { provide: FactoryCatalogueService, useValue: new FactoryCatalogueService(sql, bridgeDb(), config, {} as never, status) },
      { provide: FactorySetupService, useValue: {} },
      { provide: SetupStatusService, useValue: status },
    ],
  })
  class RoutesModule {}
  app = await NestFactory.create<NestFastifyApplication>(RoutesModule, new FastifyAdapter(), { logger: false });
  await app.init();
  installRawJsonParser(app);
  inject = (app.getHttpAdapter().getInstance() as unknown as { inject: Inject }).inject.bind(app.getHttpAdapter().getInstance());
});

after(async () => {
  await app?.close();
  if (kekPrior === undefined) delete process.env.BRIDGE_HMAC_KEK; else process.env.BRIDGE_HMAC_KEK = kekPrior;
  await closeTestClient();
});

function created() {
  const reqId = randomUUID();
  return {
    event_id: randomUUID(), version: 1, type: 'ProductionRequirementCreated', org_id: randomUUID(), correlation_id: randomUUID(),
    causation_id: null, occurred_at: new Date().toISOString(), source: 'alembic', aggregate: { type: 'production_requirement', id: reqId },
    payload: { requirement_id: reqId, order_ref: 'SO-ROUTE', mapped_sku: 'FSKU-ROUTE', qty: '10', uom: 'kg', pack_size: null, needed_by: '2026-12-01T00:00:00.000Z', priority: 'normal' },
  };
}
const postEvent = (raw: string, sig: string | null) => inject({
  method: 'POST', url: '/v1/bridge/alembic/events', payload: raw,
  headers: { 'content-type': 'application/json', ...(sig ? { 'x-bridge-signature': sig } : {}) },
});

test('events route: a signed event is applied 200; bad, tampered and missing signatures 401; malformed 400', async () => {
  // Whitespace the parser would not reproduce: only the exact bytes verify.
  const raw = JSON.stringify(created(), null, 2);
  assert.equal((await postEvent(raw, signBody(raw, SECRET))).statusCode, 200);
  const raw2 = JSON.stringify(created());
  assert.equal((await postEvent(raw2, signBody(raw2, 'another-secret'))).statusCode, 401);
  assert.equal((await postEvent(raw2.replace('SO-ROUTE', 'SO-R0UTE'), signBody(raw2, SECRET))).statusCode, 401);
  assert.equal((await postEvent(raw2, null)).statusCode, 401);
  const bad = JSON.stringify({ ...created(), payload: { order_ref: 'SO-X' } });
  assert.equal((await postEvent(bad, signBody(bad, SECRET))).statusCode, 400);
});

function syncCall(body: unknown, o: { ts?: number; nonce?: string; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(o.ts ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? randomUUID();
  return inject({
    method: 'POST', url: '/v1/bridge/catalogue/sync', payload: raw,
    headers: { 'content-type': 'application/json', 'x-bridge-signature': signBody(`${timestamp}.${nonce}.${raw}`, o.secret ?? SECRET), 'x-bridge-timestamp': timestamp, 'x-bridge-nonce': nonce },
  });
}

test('catalogue route: signed 200; bad signature, stale timestamp and replayed nonce 401; another tenant 403', async () => {
  const body = { tenantId: TENANT, op: 'status', items: [] };
  const nonce = randomUUID();
  assert.equal((await syncCall(body, { nonce })).statusCode, 200);
  assert.equal((await syncCall(body, { nonce })).statusCode, 401, 'the same nonce twice is a replay');
  assert.equal((await syncCall(body, { secret: 'another-secret' })).statusCode, 401);
  assert.equal((await syncCall(body, { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode, 401);
  assert.equal((await syncCall({ ...body, tenantId: randomUUID() })).statusCode, 403);
});
