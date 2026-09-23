/**
 * §109.8 lifecycle — DRAFT → VERSIONED → REVIEW → APPROVED → LOCKED → SUPERSEDED — against
 * real Postgres (lane U4's/U4b's own throwaway `formula` schema, `db.ts` in this directory),
 * real VaultService/FormulasService/ApprovalsService, same harness pattern as
 * vault-sod.test.ts. Proves:
 *   - finalize: DRAFT → VERSIONED permitted with sealed ingredients, denied with none, denied
 *     once already VERSIONED
 *   - submitForReview: DRAFT|VERSIONED → REVIEW permitted, denied once already REVIEW
 *   - approve/reject accept DRAFT, VERSIONED, AND REVIEW (the checkpoint is optional, not a
 *     hard gate)
 *   - lock: APPROVED → LOCKED permitted, denied from any other status
 *   - LOCKED is immutable (ingredient edits refused, same as APPROVED) AND still decryptable
 *     (VaultService.decryptVersion accepts APPROVED or LOCKED)
 *   - auto-supersede: approving a formula's successor version flips the PRIOR current
 *     (APPROVED/LOCKED) version to SUPERSEDED with supersededByVersionId set, and the audit
 *     chain still verifies end-to-end afterward
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { uuidv7 } from '@core/data-kernel';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_u4_vault_test',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: TEST_KEK,
});

const stubMasterdata = {
  findMaterial: async () => null,
  findAliasForMaterial: async () => null,
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async () => [],
};

let db: ReturnType<typeof formulaDb>;
let vault: VaultService;
let formulas: FormulasService;
let approvals: ApprovalsService;

const userA = uuidv7();
const userB = uuidv7();
const principalA = principal({ userId: userA });
const principalB = principal({ userId: userB });

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  vault = new VaultService(db as any, kms);
  formulas = new FormulasService(db as any, kms, vault, stubMasterdata as any);
  approvals = new ApprovalsService(db as any, vault);
});

afterAll(async () => {
  await closeTestClient();
});

/** A ⇒ author, B ⇒ reviewer. Returns a DRAFT version with one sealed ingredient. */
async function newDraftVersion(formulaCode?: string): Promise<{ formulaId: string; versionId: string; versionNumber: number }> {
  const formula = await formulas.createFormula(
    { formulaCode: formulaCode ?? `LC-${uuidv7()}`, formulaName: 'Lifecycle test formula' },
    principalA,
  );
  const versionNumber = 1;
  const version = await formulas.createVersion(
    { formulaId: formula.formulaId, versionNumber },
    principalA,
  );
  await formulas.addIngredients(
    version.formulaVersionId,
    { ingredients: [{ materialId: uuidv7(), percentage: 10 }] },
    principalA,
  );
  return { formulaId: formula.formulaId, versionId: version.formulaVersionId, versionNumber };
}

/* ── finalize: DRAFT → VERSIONED ────────────────────────────────────────────────────────── */

test('lifecycle: finalize permitted DRAFT → VERSIONED with a sealed ingredient', async () => {
  const { versionId } = await newDraftVersion();
  const updated = await formulas.finalizeVersion(versionId, principalA);
  assert.equal(updated.status, 'VERSIONED');
});

test('lifecycle: finalize denied with no sealed ingredients', async () => {
  const formula = await formulas.createFormula({ formulaCode: `LC-${uuidv7()}`, formulaName: 'Empty' }, principalA);
  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, principalA);
  await assert.rejects(
    () => formulas.finalizeVersion(version.formulaVersionId, principalA),
    /no sealed ingredients/,
  );
});

test('lifecycle: finalize denied once already VERSIONED (not DRAFT)', async () => {
  const { versionId } = await newDraftVersion();
  await formulas.finalizeVersion(versionId, principalA);
  await assert.rejects(
    () => formulas.finalizeVersion(versionId, principalA),
    /not DRAFT/,
  );
});

/* ── submitForReview: DRAFT|VERSIONED → REVIEW ──────────────────────────────────────────── */

test('lifecycle: submitForReview permitted from DRAFT', async () => {
  const { versionId } = await newDraftVersion();
  const updated = await approvals.submitForReview(versionId, {}, principalA);
  assert.equal(updated.status, 'REVIEW');
  assert.equal(updated.submittedBy, userA);
});

test('lifecycle: submitForReview permitted from VERSIONED', async () => {
  const { versionId } = await newDraftVersion();
  await formulas.finalizeVersion(versionId, principalA);
  const updated = await approvals.submitForReview(versionId, {}, principalA);
  assert.equal(updated.status, 'REVIEW');
});

test('lifecycle: submitForReview denied once already REVIEW', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.submitForReview(versionId, {}, principalA);
  await assert.rejects(
    () => approvals.submitForReview(versionId, {}, principalA),
    /cannot be submitted for review/,
  );
});

/* ── approve/reject accept DRAFT, VERSIONED, AND REVIEW ─────────────────────────────────── */

test('lifecycle: approve permitted from REVIEW (full DRAFT→VERSIONED→REVIEW→APPROVED path)', async () => {
  const { versionId } = await newDraftVersion();
  await formulas.finalizeVersion(versionId, principalA);
  await approvals.submitForReview(versionId, {}, principalA);
  const { version } = await approvals.approveVersion(versionId, {}, principalB);
  assert.equal(version.status, 'APPROVED');
});

test('lifecycle: reject permitted from REVIEW', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.submitForReview(versionId, {}, principalA);
  const { version } = await approvals.rejectVersion(versionId, { remarks: 'no good' }, principalA);
  assert.equal(version.status, 'REJECTED');
});

test('lifecycle: approve still permitted directly from DRAFT — the REVIEW checkpoint is optional, not mandatory', async () => {
  const { versionId } = await newDraftVersion();
  const { version } = await approvals.approveVersion(versionId, {}, principalB);
  assert.equal(version.status, 'APPROVED');
});

test('lifecycle: SoD (§108) still refuses self-approve from REVIEW, same as from DRAFT', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.submitForReview(versionId, {}, principalA);
  await assert.rejects(
    () => approvals.approveVersion(versionId, {}, principalA),
    /segregation of duties/i,
  );
});

/* ── lock: APPROVED → LOCKED ─────────────────────────────────────────────────────────────── */

test('lifecycle: lock permitted from APPROVED', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.approveVersion(versionId, {}, principalB);
  const locked = await approvals.lockVersion(versionId, {}, principalB);
  assert.equal(locked.status, 'LOCKED');
  assert.equal(locked.lockedBy, userB);
});

test('lifecycle: lock denied from DRAFT (must be APPROVED first)', async () => {
  const { versionId } = await newDraftVersion();
  await assert.rejects(
    () => approvals.lockVersion(versionId, {}, principalB),
    /must be APPROVED to lock/,
  );
});

test('lifecycle: lock denied once already LOCKED', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.approveVersion(versionId, {}, principalB);
  await approvals.lockVersion(versionId, {}, principalB);
  await assert.rejects(
    () => approvals.lockVersion(versionId, {}, principalB),
    /must be APPROVED to lock/,
  );
});

/* ── LOCKED is immutable AND still decryptable ──────────────────────────────────────────── */

test('lifecycle: a LOCKED version refuses ingredient edits (immutable, same as APPROVED)', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.approveVersion(versionId, {}, principalB);
  await approvals.lockVersion(versionId, {}, principalB);
  await assert.rejects(
    () => formulas.addIngredients(versionId, { ingredients: [{ materialId: uuidv7(), percentage: 1 }] }, principalA),
    /not DRAFT — recipe is locked/,
  );
});

test('lifecycle: a LOCKED version is still decryptable (VaultService accepts APPROVED or LOCKED)', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.approveVersion(versionId, {}, principalB);
  await approvals.lockVersion(versionId, {}, principalB);
  const result = await formulas.getActualFormula(versionId, 'lifecycle test reveal', principalA);
  assert.equal(result.ingredients.length, 1);
});

/* ── auto-supersede: approving a successor flips the PRIOR current version to SUPERSEDED ─── */

test('lifecycle: approving v2 auto-supersedes v1 (APPROVED prior) with supersededByVersionId set', async () => {
  const formula = await formulas.createFormula({ formulaCode: `LC-${uuidv7()}`, formulaName: 'Supersede test' }, principalA);
  const v1 = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, principalA);
  await formulas.addIngredients(v1.formulaVersionId, { ingredients: [{ materialId: uuidv7(), percentage: 5 }] }, principalA);
  await approvals.approveVersion(v1.formulaVersionId, {}, principalB);

  const v2 = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 2 }, principalA);
  await formulas.addIngredients(v2.formulaVersionId, { ingredients: [{ materialId: uuidv7(), percentage: 7 }] }, principalA);
  await approvals.approveVersion(v2.formulaVersionId, {}, principalB);

  const v1After = await formulas.getVersion(v1.formulaVersionId);
  assert.equal(v1After!.status, 'SUPERSEDED');
  assert.equal(v1After!.supersededByVersionId, v2.formulaVersionId);

  const masterAfter = await formulas.getFormula(formula.formulaId);
  assert.equal(masterAfter!.currentVersionId, v2.formulaVersionId);
});

test('lifecycle: auto-supersede also fires when the prior current version was LOCKED', async () => {
  const formula = await formulas.createFormula({ formulaCode: `LC-${uuidv7()}`, formulaName: 'Supersede-locked test' }, principalA);
  const v1 = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, principalA);
  await formulas.addIngredients(v1.formulaVersionId, { ingredients: [{ materialId: uuidv7(), percentage: 5 }] }, principalA);
  await approvals.approveVersion(v1.formulaVersionId, {}, principalB);
  await approvals.lockVersion(v1.formulaVersionId, {}, principalB);

  const v2 = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 2 }, principalA);
  await formulas.addIngredients(v2.formulaVersionId, { ingredients: [{ materialId: uuidv7(), percentage: 9 }] }, principalA);
  await approvals.approveVersion(v2.formulaVersionId, {}, principalB);

  const v1After = await formulas.getVersion(v1.formulaVersionId);
  assert.equal(v1After!.status, 'SUPERSEDED');
  assert.equal(v1After!.supersededByVersionId, v2.formulaVersionId);
});

test('lifecycle: the audit chain still verifies end-to-end after every transition above', async () => {
  const result = await vault.verifyAuditChain();
  assert.equal(result.ok, true, result.reason ?? 'chain must verify');
});
