/**
 * ProductionVaultPort — `VAULT_PORT` on the main app box (lane vaultport-rp). Real Postgres
 * (backend/test-support) for this box's masterdata; the Vault's HTTP client is a fake returning
 * WIRE shapes (keyed material references, computed with the real `materialRef` and the same key).
 *
 * Proves: a pick-list reference resolves to this box's material_id and keeps the Vault's required
 * quantity; an instruction reference resolves to the material's floor code (its LATEST RM alias —
 * the one the Vault's own alias lookup picked); a material with no alias gives `code: null`; a
 * reference this factory does not know refuses the order (409, sequence numbers only) but yields
 * `code: null` in an instruction; null from the Vault passes through; the key must be configured.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@core/backend-kernel';
import { materialRef, materialRefKey, type CodedMaterialLine, type CodedPickLine, type VaultApiClient } from '@ra/cluster-formula';
import { ProductionVaultPort } from '../production-vault-port.js';
import { ensureSchema, productionDb, testClient, closeTestClient, materialWithAlias } from '../../../../test-support/db.js';

const BRIDGE_KEY = `pvp-test-${'k'.repeat(32)}`;
const key = materialRefKey(BRIDGE_KEY);

let pickLines: CodedPickLine[] | null = null;
let mfgLines: CodedMaterialLine[] | null = null;
const fakeClient = {
  async pickList() {
    return pickLines;
  },
  async manufacturingLines() {
    return mfgLines;
  },
} as unknown as VaultApiClient;

function config(extra: Record<string, string> = {}): ConfigService {
  return new ConfigService({ DATABASE_URL: 'postgres://apple@localhost:5432/unused', JWT_SECRET: 'x'.repeat(32), ...extra } as NodeJS.ProcessEnv);
}

let port: ProductionVaultPort;

before(async () => {
  await ensureSchema();
  port = new ProductionVaultPort(fakeClient, productionDb(), config({ INTERNAL_BRIDGE_KEY: BRIDGE_KEY }));
});

afterAll(async () => {
  await closeTestClient();
});

test('resolvePickList: each keyed reference becomes this box\'s material_id; quantities and order are kept', async () => {
  const a = await materialWithAlias();
  const b = await materialWithAlias();
  pickLines = [
    { materialRef: materialRef(key, b.materialId), requiredQty: '0.9012', sequenceNo: 1 },
    { materialRef: materialRef(key, a.materialId.toUpperCase()), requiredQty: '2.4333', sequenceNo: 2 },
  ];
  assert.deepEqual(await port.resolvePickList(randomUUID(), 7.3, { actorId: null }), [
    { materialId: b.materialId, requiredQty: '0.9012', sequenceNo: 1 },
    { materialId: a.materialId, requiredQty: '2.4333', sequenceNo: 2 },
  ]);
});

test('resolvePickList: a reference this factory does not know refuses the order (409, sequence numbers only)', async () => {
  const unknownMaterial = randomUUID();
  pickLines = [{ materialRef: materialRef(key, unknownMaterial), requiredQty: '1.0000', sequenceNo: 3 }];
  await assert.rejects(
    () => port.resolvePickList(randomUUID(), 1, { actorId: null }),
    (e: unknown) =>
      e instanceof ConflictException && /sequence 3\b/.test((e as Error).message) && !(e as Error).message.includes(unknownMaterial),
  );
});

test('resolveManufacturingInstruction: floor code = the material\'s latest RM alias; none -> code null', async () => {
  const a = await materialWithAlias();
  const newer = `RM-NEWER-${randomUUID().slice(0, 6)}`;
  // A second, later alias (uuidv7-ordered like the app's own ids) is the one the Vault's lookup used.
  await testClient()`insert into masterdata.rm_alias (rm_alias_id, material_id, alias_name, alias_type, status)
                     values (${'ffffffff-ffff-7fff-bfff-' + randomUUID().slice(-12)}, ${a.materialId}, ${newer}, 'FLOOR_CODE', 'ACTIVE')`;
  const bare = randomUUID();
  await testClient()`insert into masterdata.material (material_id, material_code, material_name, status)
                     values (${bare}, ${`MAT-${bare.slice(0, 8)}`}, 'No floor code', 'ACTIVE')`;
  mfgLines = [
    { materialRef: materialRef(key, a.materialId), quantity: 2.433, uom: 'kg', sequenceNo: 1 },
    { materialRef: materialRef(key, bare), quantity: 1.5, uom: 'kg', sequenceNo: 2 },
    { materialRef: materialRef(key, randomUUID()), quantity: 0.25, uom: 'kg', sequenceNo: 3 },
  ];
  assert.deepEqual(await port.resolveManufacturingInstruction(randomUUID(), 7.3, { actorId: null }), [
    { code: newer, quantity: 2.433, uom: 'kg', sequenceNo: 1 },
    { code: null, quantity: 1.5, uom: 'kg', sequenceNo: 2 },
    { code: null, quantity: 0.25, uom: 'kg', sequenceNo: 3 },
  ]);
});

test('null from the Vault (unknown version) passes through for both reads', async () => {
  pickLines = null;
  mfgLines = null;
  assert.equal(await port.resolvePickList(randomUUID(), 1, { actorId: null }), null);
  assert.equal(await port.resolveManufacturingInstruction(randomUUID(), 1, { actorId: null }), null);
});

test('refuses to resolve references without INTERNAL_BRIDGE_KEY (never an unkeyed guess)', async () => {
  const unkeyed = new ProductionVaultPort(fakeClient, productionDb(), config());
  pickLines = [{ materialRef: 'x', requiredQty: '1.0000', sequenceNo: 1 }];
  await assert.rejects(() => unkeyed.resolvePickList(randomUUID(), 1, { actorId: null }), /INTERNAL_BRIDGE_KEY/);
});
