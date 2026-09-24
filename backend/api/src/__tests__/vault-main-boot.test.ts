/**
 * PB-03 remainder — `VaultAppModule` boots real Nest + Fastify with ONLY
 * `FORMULA_DATABASE_URL` + a mock KMS (`FORMULA_KEK`, dev/test EnvKmsAdapter — see
 * `resolveKmsAdapter`) + `JWT_SECRET` set, and NO `DATABASE_URL` at all. This is the literal
 * fix for the lane's "Problem": vault-api on the isolated vault EC2 has no network path to the
 * main schema Postgres and must never be handed its credential — this test proves the process
 * comes up anyway.
 *
 * Uses `fastify.inject()` (the same mechanism `CryptoController.rpc` already relies on) rather
 * than binding a real port — no network, no other process.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ensureSchema, closeTestClient } from '../../../cluster-formula/src/__tests__/db.js';

const ORIGINAL_ENV = { ...process.env };

let app: NestFastifyApplication;

before(async () => {
  delete process.env.DATABASE_URL; // the whole point — the Vault box must never have this
  process.env.VAULT_MODE = 'true';
  process.env.FORMULA_DATABASE_URL = process.env.FORMULA_TEST_DATABASE_URL
    ?? process.env.TEST_DATABASE_URL
    ?? 'postgres://apple@localhost:5432/rawprod_vonly_test';
  process.env.JWT_SECRET = 'x'.repeat(32);
  process.env.FORMULA_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg='; // mock KMS (dev/test EnvKmsAdapter)
  process.env.APP_ENV = 'dev';

  await ensureSchema();

  const { VaultAppModule } = await import('../vault-app.module.js');
  app = await NestFactory.create<NestFastifyApplication>(VaultAppModule, new FastifyAdapter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  await closeTestClient();
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

test('VaultAppModule boots with no DATABASE_URL at all', () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.ok(app, 'the Nest application context was created');
});

test('/health reports up (pings FORMULA_PG_CLIENT, not the main DB)', async () => {
  const fastify = app.getHttpAdapter().getInstance();
  const res = await fastify.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.deps.formulaDatabase, 'up');
});

test('a formula plaintext route IS mounted (vault mode) — reachable, refuses for lack of a token rather than 404ing', async () => {
  const fastify = app.getHttpAdapter().getInstance();
  const res = await fastify.inject({ method: 'GET', url: '/v1/formulas' });
  assert.notEqual(res.statusCode, 404, 'expected the route to exist in vault mode');
  assert.equal(res.statusCode, 401, 'no bearer token was sent');
});

test('the internal vault-port endpoint is mounted and refuses an unsigned call (InternalBridgeGuard, not JwtAuthGuard)', async () => {
  const fastify = app.getHttpAdapter().getInstance();
  const res = await fastify.inject({
    method: 'POST',
    url: '/internal/vault/resolve-manufacturing-instruction',
    payload: { formulaVersionId: 'fv-1', permittedBatchQuantity: 1, ctx: { actorId: null } },
  });
  assert.notEqual(res.statusCode, 404);
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.payload);
  assert.equal(body.error.code, 'INTERNAL_BRIDGE_UNAUTHORIZED');
});

test('an unknown route still 404s (the app is otherwise a normal, narrow surface)', async () => {
  const fastify = app.getHttpAdapter().getInstance();
  const res = await fastify.inject({ method: 'GET', url: '/v1/production-orders' });
  assert.equal(res.statusCode, 404, 'ProductionModule must never be part of VaultAppModule');
});
