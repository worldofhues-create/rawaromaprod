/**
 * §109.7 `VaultPort.resolveManufacturingInstruction` — production gets CODED output only.
 * Real Postgres (lane U4b's own throwaway `formula` schema, `db.ts` in this directory), real
 * VaultService/FormulasService/ApprovalsService/FormulaLookupService wired together exactly
 * as FormulaModule wires them (a fake MasterdataLookup stands in for the masterdata cluster —
 * FormulaLookupService only ever calls `findAliasForMaterial`, never the real material table).
 *
 * Proves the exact requirement: a production-role response for a manufacturing instruction
 * NEVER contains the raw formula percentage or the real material_id — only a coded alias +
 * a quantity resolved for the specific batch. Also proves getFloorView (the other
 * production-facing read) carries the same guarantee for its own shape (alias + %, no
 * material_id — % there is fine, it's the version's OWN masking contract, but material_id
 * must still never appear).
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { FormulaLookupService } from '../formula-lookup.service.js';
import { uuidv7 } from '@core/data-kernel';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_u4_vault_test',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: TEST_KEK,
});

// The one real material this suite decrypts, and the CODE the fake alias resolver returns for
// it — asserted to be the only material-identifying string allowed in any response below.
const REAL_MATERIAL_ID = uuidv7();
const ALIAS_CODE = 'RM-A123';

const fakeMasterdata = {
  findMaterial: async () => null,
  findAliasForMaterial: async (materialId: string) =>
    materialId === REAL_MATERIAL_ID ? { rmAliasId: 'alias-1', aliasName: ALIAS_CODE } : null,
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async () => [],
};

let vault: VaultService;
let formulas: FormulasService;
let approvals: ApprovalsService;
let lookup: FormulaLookupService;

const author = principal({ userId: uuidv7() });
const approver = principal({ userId: uuidv7() });

before(async () => {
  await ensureSchema();
  const db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  vault = new VaultService(db as any, kms);
  formulas = new FormulasService(db as any, kms, vault, fakeMasterdata as any);
  approvals = new ApprovalsService(db as any, vault);
  lookup = new FormulaLookupService(vault, fakeMasterdata as any);
});

afterAll(async () => {
  await closeTestClient();
});

async function approvedVersion(percentage: number): Promise<string> {
  const formula = await formulas.createFormula(
    { formulaCode: `MI-${uuidv7()}`, formulaName: 'Manufacturing instruction test' },
    author,
  );
  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, author);
  await formulas.addIngredients(
    version.formulaVersionId,
    { ingredients: [{ materialId: REAL_MATERIAL_ID, percentage, sequenceNo: 1 }] },
    author,
  );
  await approvals.approveVersion(version.formulaVersionId, {}, approver);
  return version.formulaVersionId;
}

test('manufacturing instruction: resolves a coded quantity for the batch, never the raw percentage', async () => {
  const versionId = await approvedVersion(10); // 10% of the batch
  const instructions = await lookup.resolveManufacturingInstruction(versionId, 50, { actorId: approver.userId });
  assert.ok(instructions);
  assert.equal(instructions!.length, 1);
  const line = instructions![0]!;
  assert.equal(line.code, ALIAS_CODE);
  assert.equal(line.quantity, 5); // 10% of 50kg permitted batch quantity
  assert.equal(line.uom, 'kg');

  const json = JSON.stringify(instructions);
  assert.ok(!json.includes(REAL_MATERIAL_ID), 'the real material_id must never appear in a manufacturing-instruction response');
  assert.ok(!('percentage' in line), 'a manufacturing-instruction line must never carry a "percentage" key');
  assert.ok(!('materialId' in line), 'a manufacturing-instruction line must never carry a "materialId" key');
});

test('manufacturing instruction: a different batch size resolves a different coded quantity (proves it is NOT the raw percentage in disguise)', async () => {
  const versionId = await approvedVersion(25); // 25%
  const small = await lookup.resolveManufacturingInstruction(versionId, 10, { actorId: approver.userId });
  const large = await lookup.resolveManufacturingInstruction(versionId, 200, { actorId: approver.userId });
  assert.equal(small![0]!.quantity, 2.5);
  assert.equal(large![0]!.quantity, 50);
  assert.notEqual(small![0]!.quantity, large![0]!.quantity);
});

test('manufacturing instruction: refuses (never leaks) for a version that is not approved/locked yet', async () => {
  const formula = await formulas.createFormula({ formulaCode: `MI-${uuidv7()}`, formulaName: 'Still draft' }, author);
  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, author);
  await formulas.addIngredients(version.formulaVersionId, { ingredients: [{ materialId: uuidv7(), percentage: 3 }] }, author);
  await assert.rejects(
    () => lookup.resolveManufacturingInstruction(version.formulaVersionId, 100, { actorId: author.userId }),
    /not approved\/locked/,
  );
});

test('manufacturing instruction: is audited (writes formula.manufacturing_instruction.resolve)', async () => {
  const versionId = await approvedVersion(5);
  await lookup.resolveManufacturingInstruction(versionId, 20, { actorId: approver.userId });
  const result = await vault.verifyAuditChain();
  assert.equal(result.ok, true, result.reason ?? 'chain must verify');
});

/* ── the OTHER production-facing read (getFloorView) also never carries material_id ──────── */

test('floor view: masked ingredient never carries the real material_id either', async () => {
  const versionId = await approvedVersion(15);
  const floor = await lookup.getFloorView(versionId, { actorId: approver.userId });
  assert.ok(floor);
  const json = JSON.stringify(floor);
  assert.ok(!json.includes(REAL_MATERIAL_ID), 'getFloorView must never leak the real material_id');
  assert.equal(floor![0]!.aliasName, ALIAS_CODE);
});
