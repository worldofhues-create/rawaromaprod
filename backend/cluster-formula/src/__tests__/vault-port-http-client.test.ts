/**
 * `VaultApiClient` (the main app box's signed HTTP client to the Vault) against a FAKE vault
 * server (`node:http`, not a real Nest app — this proves the CLIENT's contract: it signs correctly,
 * sends the right shape to the right path, and maps the vault's HTTP status back to the equivalent
 * Nest exception; an unreachable Vault is a 503). The receiving-side controller is exercised by
 * vault-main-boot.test.ts, and both sides together over real HTTP by vault-isolation-harness.test.ts.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { verifyInternalBridgeSignature } from '../../../backend-kernel/src/edge/internal-bridge-signing.js';
import { VAULT_INTERNAL_PATHS, VaultApiClient, VaultSecurityAuditClient } from '../vault-port.js';

const KEY = 'a-shared-secret-distributed-via-ssm';

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

function config(overrides: Record<string, string> = {}): ConfigService {
  return new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test',
    JWT_SECRET: 'x'.repeat(32),
    VAULT_API_INTERNAL_URL: baseUrl,
    INTERNAL_BRIDGE_KEY: KEY,
    ...overrides,
  });
}

function client(overrides: Record<string, string> = {}): VaultApiClient {
  return new VaultApiClient(config(overrides));
}

const REF = 'q3Wv8m0cXb2yH1rS6tPz4LkN9dJfAeGiOuYwRxTsBcE';

test('pickList: a correctly signed POST to /internal/vault/resolve-pick-list with the order quantity', async () => {
  const line = { materialRef: REF, requiredQty: '2.4333', sequenceNo: 1 };
  nextResponse = { status: 200, body: { result: [line] } };
  const result = await client().pickList('fv-9', 7.3, { actorId: 'user-9' });
  assert.deepEqual(result, [line]);
  assert.equal(lastRequest?.method, 'POST');
  assert.equal(lastRequest?.url, '/internal/vault/resolve-pick-list');
  assert.equal(lastRequest?.url, VAULT_INTERNAL_PATHS.pickList);
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), { formulaVersionId: 'fv-9', orderQty: 7.3, ctx: { actorId: 'user-9' } });
});

test('manufacturingLines: a correctly signed POST to /internal/vault/resolve-manufacturing-lines', async () => {
  const line = { materialRef: REF, quantity: 5, uom: 'kg', sequenceNo: 1 };
  nextResponse = { status: 200, body: { result: [line] } };
  const result = await client().manufacturingLines('fv-1', 10, { actorId: 'user-1', requestId: 'req-1' });
  assert.deepEqual(result, [line]);
  assert.equal(lastRequest?.url, '/internal/vault/resolve-manufacturing-lines');
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), {
    formulaVersionId: 'fv-1',
    permittedBatchQuantity: 10,
    ctx: { actorId: 'user-1', requestId: 'req-1' },
  });
});

test('a null result (unknown version) passes through as null', async () => {
  nextResponse = { status: 200, body: { result: null } };
  assert.equal(await client().pickList('fv-none', 1, { actorId: null }), null);
  assert.equal(await client().manufacturingLines('fv-none', 1, { actorId: null }), null);
});

test('a 403 from the vault (not approved/locked) is re-thrown as ForbiddenException on the caller side', async () => {
  nextResponse = { status: 403, body: 'formula version is not approved/locked — decryption denied' };
  await assert.rejects(() => client().pickList('fv-2', 10, { actorId: 'u' }), ForbiddenException);
  await assert.rejects(() => client().manufacturingLines('fv-2', 10, { actorId: 'u' }), ForbiddenException);
});

test('a 404 from the vault is re-thrown as NotFoundException', async () => {
  nextResponse = { status: 404, body: 'not found' };
  await assert.rejects(() => client().pickList('fv-3', 10, { actorId: 'u' }), NotFoundException);
});

test('an unreachable Vault is a 503 (ServiceUnavailableException), not a raw socket error', async () => {
  // nothing listens on port 1
  await assert.rejects(
    () => client({ VAULT_API_INTERNAL_URL: 'http://127.0.0.1:1' }).pickList('fv-1', 1, { actorId: null }),
    ServiceUnavailableException,
  );
});

test('refuses to call out at all when VAULT_API_INTERNAL_URL/INTERNAL_BRIDGE_KEY are unconfigured (503, says why)', async () => {
  const unconfigured = new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test',
    JWT_SECRET: 'x'.repeat(32),
  });
  await assert.rejects(
    () => new VaultApiClient(unconfigured).pickList('fv-1', 10, { actorId: null }),
    (e: unknown) => e instanceof ServiceUnavailableException && /VAULT_API_INTERNAL_URL and INTERNAL_BRIDGE_KEY/.test((e as Error).message),
  );
});

/* ── security-audit writes (SECURITY_AUDIT_SINK on the main box) ─────────────────────────── */

test('VaultSecurityAuditClient: a signed POST of the entry to /internal/vault/security-audit', async () => {
  nextResponse = { status: 201, body: { recorded: true } };
  const entry = {
    actorId: '0199a1b2-0000-7000-8000-000000000002',
    action: 'security.permission.denied',
    entityType: 'permission',
    entityId: null,
    reason: 'missing: formula:actual:read',
    result: 'refuse' as const,
  };
  await new VaultSecurityAuditClient(client()).record(entry);
  assert.equal(lastRequest?.url, VAULT_INTERNAL_PATHS.securityAudit);
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), entry);
});

/* ── lane fread-rp: the main box's screens' non-recipe reads + the catalogue push ─────────────── */

test('formulaLabels: a signed POST to /internal/vault/formula-labels with the ids; returns the result', async () => {
  const result = { versions: [], formulas: [{ formulaId: 'f-1', formulaCode: 'FRM-1' }], recent: null };
  nextResponse = { status: 201, body: { result } };
  const query = { formulaVersionIds: ['fv-1'], formulaIds: ['f-1'], recent: true };
  assert.deepEqual(await client().formulaLabels(query), result);
  assert.equal(lastRequest?.url, '/internal/vault/formula-labels');
  assert.equal(lastRequest?.url, VAULT_INTERNAL_PATHS.formulaLabels);
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), query);
});

test('formulaLabels: a caller-chosen timeout gives up early with a 503', async () => {
  const slow = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const port = (slow.address() as { port: number }).port;
  const started = Date.now();
  try {
    await assert.rejects(
      () => client({ VAULT_API_INTERNAL_URL: `http://127.0.0.1:${port}` }).formulaLabels({ formulaVersionIds: [], formulaIds: [] }, { timeoutMs: 300 }),
      ServiceUnavailableException,
    );
    assert.ok(Date.now() - started < 5_000, 'well under the default 15 s');
  } finally {
    slow.closeAllConnections();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  }
});

test('accessAudit: a signed POST of limit + cursor to /internal/vault/access-audit', async () => {
  const page = { items: [], nextCursor: null };
  nextResponse = { status: 201, body: { result: page } };
  assert.deepEqual(await client().accessAudit(200, '400'), page);
  assert.equal(lastRequest?.url, VAULT_INTERNAL_PATHS.accessAudit);
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), { limit: 200, cursor: '400' });
});

test('materialCatalogue: a signed POST of the probe / part to /internal/vault/material-catalogue', async () => {
  nextResponse = { status: 201, body: { result: { current: false } } };
  const digest = 'a'.repeat(64);
  assert.deepEqual(await client().materialCatalogue({ digest }), { current: false });
  assert.equal(lastRequest?.url, VAULT_INTERNAL_PATHS.materialCatalogue);
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), { digest });
  const part = { digest, part: 0, parts: 1, materials: [{ materialId: 'm-1', materialCode: 'RM-1', materialName: 'Bergamot' }] };
  nextResponse = { status: 201, body: { result: { current: true } } };
  assert.deepEqual(await client().materialCatalogue(part), { current: true });
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), part);
});
