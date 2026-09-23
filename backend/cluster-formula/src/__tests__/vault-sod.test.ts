/**
 * Vault SoD + audit — real Postgres (lane U4's own throwaway `formula` schema, `db.ts` in
 * this directory), real VaultService/FormulasService/ApprovalsService wired together exactly
 * as FormulaModule wires them (just without the Nest DI container). Proves, against actual
 * inserted/decrypted rows rather than mocks:
 *   - self-approve refused (§108 SoD: author != approver)
 *   - edit-approved refused (pre-existing lockDraftVersionTx — regression-proofed here)
 *   - reject flow: no SoD restriction on reject, and a decided version can't be re-decided
 *   - audit row written on every plaintext read, WITH the caller's reason recorded
 *   - a refused read (not-yet-approved version) is ALSO audited (§109.8 allow/refuse result)
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { desc, eq } from 'drizzle-orm';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { uuidv7 } from '@core/data-kernel';
import * as formulaSchema from '@ra/data-formula';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const { auditEvents } = formulaSchema;

// FIXED (not per-run-random): lane U4's throwaway test DB persists across `pnpm test` runs
// (schema is applied once, never dropped — see ensureSchema in ./db.ts), and the audit chain
// is genuinely append-only. A KEK that changed between runs would make `macAudit` (HMAC keyed
// by the KEK) fail to recompute rows written under a PRIOR run's key — not real tamper, just
// a mismatched test key. A stable key keeps the chain internally consistent run over run,
// same as a real (stable, persisted-secret) KEK would in production.
const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_u4_vault_test',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: TEST_KEK,
});

let db: ReturnType<typeof formulaDb>;
let vault: VaultService;
let formulas: FormulasService;
let approvals: ApprovalsService;

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  vault = new VaultService(db as any, kms);
  formulas = new FormulasService(db as any, kms, vault);
  approvals = new ApprovalsService(db as any, vault);
});

afterAll(async () => {
  await closeTestClient();
});

/** Two distinct real users — the version's author (A) and a different reviewer (B). Author A
 * is also the formula's owner (createFormula defaults formulaOwnerUserId to the creator), so
 * A can read the plaintext of A's own approved formula without a separate access grant —
 * §108 SoD blocks self-APPROVAL, never self-reading. */
const userA = uuidv7();
const userB = uuidv7();
const principalA = principal({ userId: userA });
const principalB = principal({ userId: userB });

async function newDraftVersion(): Promise<{ formulaId: string; versionId: string }> {
  const formula = await formulas.createFormula(
    { formulaCode: `TST-${uuidv7()}`, formulaName: 'SoD test formula' },
    principalA,
  );
  const version = await formulas.createVersion(
    { formulaId: formula.formulaId, versionNumber: 1 },
    principalA, // A authors the version — createdBy = A
  );
  await formulas.addIngredients(
    version.formulaVersionId,
    { ingredients: [{ materialId: uuidv7(), percentage: 12.5, sequenceNo: 1 }] },
    principalA,
  );
  return { formulaId: formula.formulaId, versionId: version.formulaVersionId };
}

async function latestAuditRow(entityId: string, action: string) {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(desc(auditEvents.chainSeq))
    .limit(50);
  return rows.find((r) => r.action === action);
}

/* ── self-approve refused (§108) ────────────────────────────────────────────────────────── */

test('vault sod: approveVersion refuses when the caller is the version\'s own author', async () => {
  const { versionId } = await newDraftVersion();
  await assert.rejects(
    () => approvals.approveVersion(versionId, {}, principalA),
    (err: unknown) => {
      assert.match((err as Error).message, /segregation of duties/i);
      return true;
    },
  );
  const version = await formulas.getVersion(versionId);
  assert.equal(version!.status, 'DRAFT', 'a refused approval must not change the version status');

  const refusal = await latestAuditRow(versionId, 'formula.version.approve.self_refused');
  assert.ok(refusal, 'the self-approve refusal must be audited even though the approval itself was refused');
  assert.equal((refusal!.after as any)?.result, 'refuse');
});

test('vault sod: approveVersion succeeds for a reviewer who is NOT the author', async () => {
  const { versionId } = await newDraftVersion();
  const { version } = await approvals.approveVersion(versionId, { remarks: 'looks correct' }, principalB);
  assert.equal(version.status, 'APPROVED');
  assert.equal(version.approvedBy, userB);
});

/* ── edit-approved refused (regression-proofs the pre-existing lock) ───────────────────────── */

test('vault sod: an APPROVED version refuses further ingredient edits (immutable — successor version required)', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.approveVersion(versionId, {}, principalB);

  await assert.rejects(
    () =>
      formulas.addIngredients(
        versionId,
        { ingredients: [{ materialId: uuidv7(), percentage: 1 }] },
        principalA,
      ),
    /not DRAFT — recipe is locked/,
  );
});

/* ── reject: no SoD restriction, and a decided version can't be re-decided ─────────────────── */

test('vault sod: rejectVersion has no SoD restriction — the author may reject their own draft', async () => {
  const { versionId } = await newDraftVersion();
  const { version } = await approvals.rejectVersion(versionId, { remarks: 'wrong ratio, redo' }, principalA);
  assert.equal(version.status, 'REJECTED');
});

test('vault sod: a REJECTED version cannot be approved, and cannot be rejected again', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.rejectVersion(versionId, { remarks: 'redo' }, principalA);

  await assert.rejects(() => approvals.approveVersion(versionId, {}, principalB), /already decided|already approved/i);
  await assert.rejects(() => approvals.rejectVersion(versionId, { remarks: 'again' }, principalA), /already decided/i);
});

/* ── audit row written, with the caller's reason recorded (§109.6/§109.8) ──────────────────── */

test('vault audit: a successful decrypt writes an audit row carrying the caller\'s reason', async () => {
  const { versionId } = await newDraftVersion();
  await approvals.approveVersion(versionId, {}, principalB);

  const reason = 'QA investigation — batch mismatch report #4471';
  const result = await formulas.getActualFormula(versionId, reason, principalA);
  assert.equal(result.ingredients.length, 1);
  assert.equal(result.ingredients[0]!.percentage, 12.5);

  const row = await latestAuditRow(versionId, 'formula.actual.read');
  assert.ok(row, 'the decrypt must write an audit row');
  assert.equal((row!.after as any)?.reason, reason);
  assert.equal((row!.after as any)?.result, 'allow');
  assert.ok(row!.chainSeq && row!.chainSeq > 0n, 'the row must be part of the hash chain (chain_seq set)');
  assert.ok(row!.rowHash, 'the row must carry a computed row_hash');
});

test('vault audit: a refused decrypt (version not yet APPROVED) is ALSO audited', async () => {
  const { versionId } = await newDraftVersion(); // still DRAFT — never approved in this test
  await assert.rejects(
    () => formulas.getActualFormula(versionId, 'trying anyway', principalA),
    /not approved\/locked/,
  );
  const row = await latestAuditRow(versionId, 'formula.actual.read');
  assert.ok(row, 'a refused decrypt attempt must still leave an audit trace');
  assert.equal((row!.after as any)?.result, 'refuse');
});

test('vault audit: the access-audit hash chain still verifies end-to-end after all of the above', async () => {
  const result = await vault.verifyAuditChain();
  assert.equal(result.ok, true, result.reason ?? 'chain must verify');
});
