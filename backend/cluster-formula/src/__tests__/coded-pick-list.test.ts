/**
 * `FormulaLookup.resolvePickList` / `resolveManufacturingLines` — what the Vault hands the main app
 * box over the signed channel. Real Postgres (this directory's formula-schema harness), real
 * VaultService/FormulasService/ApprovalsService/FormulaLookupService. The MasterdataLookup is a
 * fake that FAILS on every call: these two reads must never need the main box's facts bridge.
 *
 * Proves: each line carries a keyed material reference (material-ref.ts) + the quantity for the
 * order/batch + the sequence number, never the real material_id, an alias, the raw percentage or
 * the formula's identity; pick-list quantities are pick-quantity.ts's; instruction quantities are
 * exactly resolveManufacturingInstruction's; the version must be approved/locked; reads are
 * audited (`formula.picklist.read`, `formula.manufacturing_instruction.resolve`); no key, no read.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import { auditEvents } from '@ra/data-formula';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { FormulaLookupService } from '../formula-lookup.service.js';
import { instructionQuantity, pickLineRequiredQty } from '../pick-quantity.js';
import { materialRef, materialRefKey } from '../material-ref.js';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const BRIDGE_KEY = `coded-pick-list-${'k'.repeat(32)}`;
const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/unused',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=',
  INTERNAL_BRIDGE_KEY: BRIDGE_KEY,
});
const key = materialRefKey(BRIDGE_KEY);

const M1 = uuidv7();
const M2 = uuidv7();

// The facts bridge (Vault -> main box) is not deployed; these reads must not touch it.
const refuse = async (): Promise<never> => {
  throw new Error('the Vault must not call the main box to answer a pick list / manufacturing lines');
};
const unreachableMasterdata = {
  findMaterial: refuse,
  findAliasForMaterial: refuse,
  findAliasesForMaterials: refuse,
  searchMaterials: refuse,
};
// FormulasService's draft editor never resolves anything in this suite either.
const fakeMasterdata = {
  findMaterial: async () => null,
  findAliasForMaterial: async () => ({ rmAliasId: uuidv7(), aliasName: 'RX-ALIAS' }),
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async () => [],
};

let db: ReturnType<typeof formulaDb>;
let formulas: FormulasService;
let approvals: ApprovalsService;
let lookup: FormulaLookupService;
let aliasLookup: FormulaLookupService;
const author = principal({ userId: uuidv7() });
const approver = principal({ userId: uuidv7() });

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const vault = new VaultService(db as any, kms);
  formulas = new FormulasService(db as any, kms, vault, fakeMasterdata as any);
  approvals = new ApprovalsService(db as any, vault);
  lookup = new FormulaLookupService(vault, unreachableMasterdata as any, config);
  aliasLookup = new FormulaLookupService(vault, fakeMasterdata as any, config);
});

afterAll(async () => {
  await closeTestClient();
});

async function version(
  ingredients: Array<{ materialId: string; percentage: number; sequenceNo: number }>,
  approve = true,
): Promise<string> {
  const formula = await formulas.createFormula({ formulaCode: `PL-${uuidv7()}`, formulaName: 'Pick list test' }, author);
  const v = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, author);
  await formulas.addIngredients(v.formulaVersionId, { ingredients }, author);
  if (approve) await approvals.approveVersion(v.formulaVersionId, {}, approver);
  return v.formulaVersionId;
}

test('resolvePickList: keyed material reference + required quantity, in sequence order', async () => {
  const versionId = await version([
    { materialId: M2, percentage: 66.66667, sequenceNo: 2 },
    { materialId: M1, percentage: 33.33333, sequenceNo: 1 },
  ]);
  const lines = await lookup.resolvePickList(versionId, 7.3, { actorId: approver.userId });
  assert.deepEqual(lines, [
    { materialRef: materialRef(key, M1), requiredQty: pickLineRequiredQty(7.3, 33.33333), sequenceNo: 1 },
    { materialRef: materialRef(key, M2), requiredQty: pickLineRequiredQty(7.3, 66.66667), sequenceNo: 2 },
  ]);
  assert.equal(lines![0]!.requiredQty, '2.4333');
});

test('resolvePickList / resolveManufacturingLines: never the material_id, an alias, the percentage or the formula identity', async () => {
  const versionId = await version([{ materialId: M1, percentage: 12.34567, sequenceNo: 1 }]);
  const pick = await lookup.resolvePickList(versionId, 100, { actorId: approver.userId });
  const mfg = await lookup.resolveManufacturingLines(versionId, 100, { actorId: approver.userId });
  for (const [lines, keys] of [
    [pick, ['materialRef', 'requiredQty', 'sequenceNo']],
    [mfg, ['materialRef', 'quantity', 'sequenceNo', 'uom']],
  ] as const) {
    const json = JSON.stringify(lines);
    assert.ok(!json.includes(M1), 'the real material_id must never leave the vault');
    assert.ok(!json.includes('12.34567'), 'the raw percentage must never leave the vault');
    for (const line of lines!) {
      // Only these fields (no formula name/code, no alias), and the reference is an opaque HMAC.
      assert.deepEqual(Object.keys(line).sort(), [...keys]);
      assert.match(line.materialRef, /^[A-Za-z0-9_-]{43}$/);
    }
  }
});

test('resolveManufacturingLines: the same quantities, uom and sequence as resolveManufacturingInstruction', async () => {
  const versionId = await version([
    { materialId: M1, percentage: 33.33333, sequenceNo: 1 },
    { materialId: M2, percentage: 66.66667, sequenceNo: 2 },
  ]);
  const lines = await lookup.resolveManufacturingLines(versionId, 7.3, { actorId: approver.userId });
  const coded = await aliasLookup.resolveManufacturingInstruction(versionId, 7.3, { actorId: approver.userId });
  assert.deepEqual(
    lines!.map(({ quantity, uom, sequenceNo }) => ({ quantity, uom, sequenceNo })),
    coded!.map(({ quantity, uom, sequenceNo }) => ({ quantity, uom, sequenceNo })),
  );
  assert.deepEqual(lines!.map((l) => l.materialRef), [materialRef(key, M1), materialRef(key, M2)]);
  assert.equal(lines![0]!.quantity, instructionQuantity(33.33333, 7.3));
});

test('both reads refuse a version that is not approved/locked; null for an unknown version', async () => {
  const draft = await version([{ materialId: M1, percentage: 100, sequenceNo: 1 }], false);
  await assert.rejects(() => lookup.resolvePickList(draft, 10, { actorId: author.userId }), ForbiddenException);
  await assert.rejects(() => lookup.resolveManufacturingLines(draft, 10, { actorId: author.userId }), ForbiddenException);
  assert.equal(await lookup.resolvePickList(uuidv7(), 10, { actorId: author.userId }), null);
  assert.equal(await lookup.resolveManufacturingLines(uuidv7(), 10, { actorId: author.userId }), null);
});

test('both reads are audited on the version, with the actor and request id', async () => {
  const versionId = await version([{ materialId: M1, percentage: 50, sequenceNo: 1 }]);
  const actorId = uuidv7();
  await lookup.resolvePickList(versionId, 4, { actorId, requestId: 'req-pl-1' });
  await lookup.resolveManufacturingLines(versionId, 4, { actorId, requestId: 'req-ml-1' });
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.entityId, versionId));
  const reads = rows
    .filter((r) => r.action === 'formula.picklist.read' || r.action === 'formula.manufacturing_instruction.resolve')
    .map((r) => ({ action: r.action, actorId: r.actorId, requestId: r.requestId }))
    .sort((x, y) => x.action.localeCompare(y.action));
  assert.deepEqual(reads, [
    { action: 'formula.manufacturing_instruction.resolve', actorId, requestId: 'req-ml-1' },
    { action: 'formula.picklist.read', actorId, requestId: 'req-pl-1' },
  ]);
});

test('no INTERNAL_BRIDGE_KEY, no keyed read (refused before any decrypt)', async () => {
  const versionId = await version([{ materialId: M1, percentage: 50, sequenceNo: 1 }]);
  const kms = new EnvKmsAdapter(config);
  const unkeyed = new FormulaLookupService(new VaultService(db as any, kms), unreachableMasterdata as any);
  await assert.rejects(() => unkeyed.resolvePickList(versionId, 1, { actorId: null }), /INTERNAL_BRIDGE_KEY/);
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.entityId, versionId));
  assert.equal(rows.filter((r) => r.action === 'formula.picklist.read').length, 0);
});
