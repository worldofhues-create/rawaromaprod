/**
 * Security review R1 #4/#5 — BridgeController.configure (PUT /v1/bridge/config).
 *
 *   #4: the ZodValidationPipe wiring itself — an unsafe webhookUrl passed through the SAME
 *       pipe the route decorator uses must be rejected with a DomainError (422 VALIDATION_FAILED),
 *       exactly like every other zod-validated route in this codebase.
 *   #5: `configure()` must record the REAL authenticated principal's userId as configuredBy,
 *       never the hardcoded string 'admin' it used before.
 *
 * Real Postgres (bridgeDb()), not a mock — same rule as every other lane test: a real db is the
 * only thing that can't lie about what actually got persisted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, ZodValidationPipe } from '@core/backend-kernel';
import { bridge as bridgeContracts } from '@core/contracts';
import { BridgeController } from '../bridge/bridge.controller.js';
import { ConfigAdminService } from '../bridge/config-admin.service.js';
import { ImporterService } from '../bridge/importer.service.js';
import { ensureSchema, bridgeDb, testClient, principal, closeTestClient } from '../../../test-support/db.js';

let controller: BridgeController;

before(async () => {
  await ensureSchema();
  const db = bridgeDb();
  const sql = testClient();
  // ImporterService needs a raw Sql client too; the importer path isn't exercised by these
  // tests, so a real client is enough to satisfy the constructor.
  const importer = new ImporterService(db, sql);
  const configAdmin = new ConfigAdminService(db);
  controller = new BridgeController(importer, configAdmin);
});

after(async () => {
  await closeTestClient();
});

test('bridge config: the ZodValidationPipe rejects an SSRF-unsafe webhookUrl with a 422 DomainError', () => {
  const pipe = new ZodValidationPipe(bridgeContracts.configureBridgeRequest);
  assert.throws(
    () => pipe.transform({ webhookUrl: 'https://169.254.169.254/latest/meta-data/' }, {} as never),
    (err: unknown) => err instanceof DomainError && (err as DomainError).status === 422,
  );
});

test('bridge config: the ZodValidationPipe accepts a well-formed public https webhookUrl', () => {
  const pipe = new ZodValidationPipe(bridgeContracts.configureBridgeRequest);
  const parsed = pipe.transform({ webhookUrl: 'https://alembic.example.com/hook' }, {} as never);
  assert.equal(parsed.webhookUrl, 'https://alembic.example.com/hook');
});

test('bridge config: configure() records the real authenticated principal as configuredBy, not a hardcoded "admin"', async () => {
  const someone = '00000000-0000-7000-8000-0000000000aa';
  await controller.configure({ enabled: true }, principal({ userId: someone }));

  const sql = testClient();
  const row = await sql`select configured_by from bridge.connector_config where id = 'default'`;
  assert.equal(row[0]!.configured_by, someone);
  assert.notEqual(row[0]!.configured_by, 'admin');
});

test('bridge config: a different caller is recorded as themselves, not the previous caller', async () => {
  const first = '00000000-0000-7000-8000-0000000000bb';
  const second = '00000000-0000-7000-8000-0000000000cc';
  await controller.configure({ enabled: true }, principal({ userId: first }));
  await controller.configure({ enabled: false }, principal({ userId: second }));

  const sql = testClient();
  const row = await sql`select configured_by from bridge.connector_config where id = 'default'`;
  assert.equal(row[0]!.configured_by, second);
});
