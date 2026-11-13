/**
 * STOCK-E2E-1: a formula version with nothing sealed on it is not approvable.
 */

import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { uuidv7 } from '@core/data-kernel';
import * as formulaSchema from '@ra/data-formula';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

void formulaSchema;

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

// Stub MasterdataLookup — this test suite exercises the seal/approve/reject/audit flows,
// never the material search picker (that's covered by material-search.test.ts), so a stub
// that throws if actually called is enough to satisfy FormulasService's constructor.
const stubMasterdata = {
  findMaterial: async () => null,
  findAliasForMaterial: async () => null,
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async () => [],
  matchMaterials: async () => [],
};

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  vault = new VaultService(db as any, kms);
  formulas = new FormulasService(db as any, kms, vault, stubMasterdata);
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

/* STOCK-E2E-1 (STK-6): the rehearsal approved a formula version that had nothing sealed on it
 * (201). The floor would then make a batch from an empty recipe: a production order with no lines,
 * and an approval on file that says a person checked a formula nobody wrote. */
test('stock-e2e: approveVersion refuses a version with nothing sealed on it', async () => {
  const formula = await formulas.createFormula({ formulaCode: `TST-${uuidv7()}`, formulaName: 'empty version probe' }, principalA);
  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, principalA);
  await assert.rejects(
    () => approvals.approveVersion(version.formulaVersionId, {}, principalB),
    (err: unknown) => /nothing is sealed/i.test((err as Error).message),
  );
  const after = await formulas.getVersion(version.formulaVersionId);
  assert.equal(after!.status, 'DRAFT', 'a refused approval leaves the version as it was');
});

test('stock-e2e: a version with a sealed line still approves (second person)', async () => {
  const formula = await formulas.createFormula({ formulaCode: `TST-${uuidv7()}`, formulaName: 'sealed version probe' }, principalA);
  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, principalA);
  await formulas.addIngredients(version.formulaVersionId, { ingredients: [{ materialId: uuidv7(), percentage: 100, sequenceNo: 1 }] }, principalA);
  const { version: v } = await approvals.approveVersion(version.formulaVersionId, {}, principalB);
  assert.equal(v.status, 'APPROVED');
});
