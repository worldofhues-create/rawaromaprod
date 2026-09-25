/**
 * Lane fread-rp — MaterialCatalogueSyncService, the main box's worker job that supplies the Vault
 * console's material picker by PUSHING over the signed main -> Vault channel (the Vault never calls
 * the main box). Real main test database for the material master; the Vault side is the real
 * `MaterialCatalogue` behind a client stub that records every call (the two real processes over
 * HTTP are vault-isolation-harness.test.ts).
 *
 * Proves: a first round pushes, an unchanged master is one digest probe and nothing else, a new
 * material is pushed on the next round and becomes searchable, only id/code/name ever leave this
 * box, and the job is off where the Vault channel is not configured.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MaterialCatalogue, type CatalogueUpdate } from '@ra/cluster-formula';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';
import { MaterialCatalogueSyncService } from '../vault-bridge/material-catalogue-sync.service.js';

const configured = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/unused',
  JWT_SECRET: 'x'.repeat(32),
  VAULT_API_INTERNAL_URL: 'http://vault.invalid:4100',
  INTERNAL_BRIDGE_KEY: 'k'.repeat(40),
});

const vaultSide = new MaterialCatalogue();
const sent: CatalogueUpdate[] = [];
const client = {
  materialCatalogue: async (u: CatalogueUpdate) => {
    sent.push(JSON.parse(JSON.stringify(u)) as CatalogueUpdate);
    return vaultSide.receive(u);
  },
};
let sync: MaterialCatalogueSyncService;
const code = `SYNC-${randomUUID().slice(0, 8)}`;

before(async () => {
  await ensureSchema();
  sync = new MaterialCatalogueSyncService(testClient(), client, configured);
  await testClient()`insert into masterdata.material (material_id, material_code, material_name, status, reorder_level)
                     values (${randomUUID()}, ${`${code}-1`}, 'Sync harness bergamot', 'ACTIVE', 12)`;
});

after(async () => {
  await closeTestClient();
});

test('a first round pushes the whole master; the Vault can search it', async () => {
  sent.length = 0;
  assert.equal(await sync.sync(), 'pushed');
  assert.equal(sent[0]!.materials, undefined, 'a digest probe first');
  assert.ok(sent.slice(1).every((u) => Array.isArray(u.materials)));
  const hits = await vaultSide.searchMaterials(code, 10);
  assert.deepEqual(hits.map((h) => h.materialName), ['Sync harness bergamot']);
});

test('only id, code and name ever leave this box (no alias, reorder level, status, cost ...)', () => {
  for (const u of sent) for (const m of u.materials ?? []) assert.deepEqual(Object.keys(m).sort(), ['materialCode', 'materialId', 'materialName']);
});

test('an unchanged master is a single digest probe', async () => {
  sent.length = 0;
  assert.equal(await sync.sync(), 'current');
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]!), ['digest']);
});

test('a new material reaches the Vault on the next round', async () => {
  await testClient()`insert into masterdata.material (material_id, material_code, material_name, status)
                     values (${randomUUID()}, ${`${code}-2`}, 'Sync harness vetiver', 'ACTIVE')`;
  assert.equal(await sync.sync(), 'pushed');
  assert.deepEqual((await vaultSide.searchMaterials(code, 10)).map((h) => h.materialCode), [`${code}-1`, `${code}-2`]);
});

test('off where the Vault channel is not configured (single-box dev): no call at all', async () => {
  const off = new MaterialCatalogueSyncService(
    testClient(),
    { materialCatalogue: async () => { throw new Error('must not be called'); } },
    new ConfigService({ DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32) }),
  );
  assert.equal(await off.sync(), 'disabled');
});
