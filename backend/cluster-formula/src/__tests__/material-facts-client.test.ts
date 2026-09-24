/**
 * PB-03 remainder — `MaterialFactsClient` (vault -> main direction) against a fake main-API
 * server, same shape as `vault-port-http-client.test.ts`'s fake vault server for the opposite
 * direction. Proves the Vault box's ONE main-DB-shaped read (material code/name/RM_ALIAS) is a
 * signed HTTP call, never a local `PG_CLIENT`.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { verifyInternalBridgeSignature } from '../../../backend-kernel/src/edge/internal-bridge-signing.js';
import { MaterialFactsClient } from '../facts-bridge/material-facts.client.js';

const KEY = 'a-shared-secret-distributed-via-ssm';

let server: Server;
let baseUrl: string;
let lastRequest: { method?: string; url?: string; rawBody: string } | undefined;
let nextResponse: unknown;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      lastRequest = { method: req.method, url: req.url, rawBody };

      const signature = req.headers['x-internal-signature'];
      const timestamp = req.headers['x-internal-timestamp'];
      const ok =
        typeof signature === 'string' &&
        typeof timestamp === 'string' &&
        verifyInternalBridgeSignature(
          KEY,
          { method: req.method ?? 'GET', path: req.url ?? '/', body: rawBody, timestamp },
          signature,
        );
      if (!ok) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad signature' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: nextResponse }));
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

function client(): MaterialFactsClient {
  const config = new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test',
    JWT_SECRET: 'x'.repeat(32),
    MAIN_API_INTERNAL_URL: baseUrl,
    INTERNAL_BRIDGE_KEY: KEY,
  });
  return new MaterialFactsClient(config);
}

test('findAliasForMaterial GETs the signed alias route', async () => {
  nextResponse = { rmAliasId: 'alias-1', aliasName: 'ING-A001' };
  const result = await client().findAliasForMaterial('mat-1');
  assert.deepEqual(result, { rmAliasId: 'alias-1', aliasName: 'ING-A001' });
  assert.equal(lastRequest?.method, 'GET');
  assert.equal(lastRequest?.url, '/internal/vault-bridge/material-alias/mat-1');
});

test('searchMaterials GETs with q/limit in the query string', async () => {
  nextResponse = [{ materialId: 'mat-1', materialCode: 'RM-1', materialName: 'Lavender', uomId: null }];
  const result = await client().searchMaterials('lav', 10);
  assert.deepEqual(result, nextResponse);
  assert.equal(lastRequest?.url, '/internal/vault-bridge/material-search?q=lav&limit=10');
});

test('findAliasesForMaterials POSTs the batch and reconstructs a Map from the returned entries', async () => {
  nextResponse = [['mat-1', { rmAliasId: 'alias-1', aliasName: 'ING-A001' }]];
  const result = await client().findAliasesForMaterials(['mat-1']);
  assert.ok(result instanceof Map);
  assert.deepEqual(result.get('mat-1'), { rmAliasId: 'alias-1', aliasName: 'ING-A001' });
  assert.equal(lastRequest?.method, 'POST');
  assert.deepEqual(JSON.parse(lastRequest!.rawBody), { materialIds: ['mat-1'] });
});

test('findAliasesForMaterials short-circuits to an empty Map without a network call for an empty input', async () => {
  lastRequest = undefined;
  const result = await client().findAliasesForMaterials([]);
  assert.deepEqual(result, new Map());
  assert.equal(lastRequest, undefined);
});

test('refuses to call out when MAIN_API_INTERNAL_URL/INTERNAL_BRIDGE_KEY are unconfigured', async () => {
  const config = new ConfigService({
    DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vonly_test',
    JWT_SECRET: 'x'.repeat(32),
  });
  await assert.rejects(() => new MaterialFactsClient(config).findAliasForMaterial('mat-1'), /MAIN_API_INTERNAL_URL|INTERNAL_BRIDGE_KEY/);
});
