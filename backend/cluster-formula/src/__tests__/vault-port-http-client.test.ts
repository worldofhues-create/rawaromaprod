/**
 * PB-03 remainder — `VaultPortHttpClient` against a FAKE vault server (`node:http`, not a real
 * Nest app — this proves the CLIENT's contract: it signs correctly, sends the right shape, and
 * maps the vault's HTTP status back to the equivalent Nest exception). The real receiving-side
 * controller (`vault-port-internal.controller.ts`, `backend/api/src`) is exercised by that
 * package's own boot test; wiring both together over real HTTP is exactly what "the coded-
 * instruction path works through the VaultPort client (with a fake vault server in tests)" asks
 * for, without pulling `backend/api` (an app) into this cluster's own test suite.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { verifyInternalBridgeSignature } from '../../../backend-kernel/src/edge/internal-bridge-signing.js';
import { VaultPortHttpClient } from '../vault-port.js';

const KEY = 'a-shared-secret-distributed-via-ssm';
const EXPECTED_PATH = '/internal/vault/resolve-manufacturing-instruction';

let server: Server;
let baseUrl: string;
let nextResponse: { status: number; body: unknown };
let lastRequest: { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; rawBody: string } | undefined;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      lastRequest = { method: req.method, url: req.url, headers: req.headers, rawBody };

      const signature = req.headers['x-internal-signature'];
      const timestamp = req.headers['x-internal-timestamp'];
      // The sender's signed per-request nonce (OPS-GREEN, lane ops-factory) is part of the message.
      const nonce = req.headers['x-internal-nonce'];
      const ok =
        typeof signature === 'string' &&
        typeof timestamp === 'string' &&
        verifyInternalBridgeSignature(
          KEY,
          { method: req.method ?? 'GET', path: req.url ?? '/', body: rawBody, timestamp,
            ...(typeof nonce === 'string' ? { nonce } : {}) },
          signature,
        );
      if (!ok) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: null, error: { message: 'bad signature' } }));
        return;
      }
      res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextResponse.status < 300 ? { data: nextResponse.body } : { error: { message: nextResponse.body } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(): VaultPortHttpClient {
  const config = new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test',
    JWT_SECRET: 'x'.repeat(32),
    VAULT_API_INTERNAL_URL: baseUrl,
    INTERNAL_BRIDGE_KEY: KEY,
  });
  return new VaultPortHttpClient(config);
}

test('sends a correctly signed POST with the right body shape', async () => {
  nextResponse = { status: 200, body: { result: [{ code: 'ING-A001', quantity: 5, uom: 'kg', sequenceNo: 1 }] } };
  const result = await client().resolveManufacturingInstruction('fv-1', 10, { actorId: 'user-1', requestId: 'req-1' });
  assert.deepEqual(result, [{ code: 'ING-A001', quantity: 5, uom: 'kg', sequenceNo: 1 }]);
  assert.equal(lastRequest?.method, 'POST');
  assert.equal(lastRequest?.url, EXPECTED_PATH);
  const sent = JSON.parse(lastRequest!.rawBody);
  assert.deepEqual(sent, { formulaVersionId: 'fv-1', permittedBatchQuantity: 10, ctx: { actorId: 'user-1', requestId: 'req-1' } });
});

test('a null result (no formula version linked) passes through as null', async () => {
  nextResponse = { status: 200, body: { result: null } };
  const result = await client().resolveManufacturingInstruction('fv-none', 10, { actorId: null });
  assert.equal(result, null);
});

test('a 403 from the vault (not approved/locked) is re-thrown as ForbiddenException on the caller side', async () => {
  nextResponse = { status: 403, body: 'formula version is not approved/locked — decryption denied' };
  await assert.rejects(
    () => client().resolveManufacturingInstruction('fv-2', 10, { actorId: 'u' }),
    (err: unknown) => {
      assert.ok(err instanceof ForbiddenException);
      return true;
    },
  );
});

test('a 404 from the vault is re-thrown as NotFoundException', async () => {
  nextResponse = { status: 404, body: 'not found' };
  await assert.rejects(
    () => client().resolveManufacturingInstruction('fv-3', 10, { actorId: 'u' }),
    (err: unknown) => {
      assert.ok(err instanceof NotFoundException);
      return true;
    },
  );
});

test('refuses to call out at all when VAULT_API_INTERNAL_URL/INTERNAL_BRIDGE_KEY are unconfigured', async () => {
  const config = new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test',
    JWT_SECRET: 'x'.repeat(32),
  });
  await assert.rejects(
    () => new VaultPortHttpClient(config).resolveManufacturingInstruction('fv-1', 10, { actorId: null }),
    /VAULT_API_INTERNAL_URL and INTERNAL_BRIDGE_KEY/,
  );
});
