/**
 * STOCK-FIX-RP (STK-5): a version is approved only when its sealed shares total exactly 100 %.
 *
 * The rehearsal committed a recipe at 99.96 % (a warning) and a second person approved it (201): every
 * batch from it would have been 0.04 % short of its own size, and the pick list would not total the
 * order. VAULT.md rule 2 says a recipe totals 100 %. The total is summed inside the Vault (sealed
 * shares, micro-percent); the refusal tells the approver the total and the difference, and the audit
 * row records the refusal with neither. Made-up shares only.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { uuidv7 } from '@core/data-kernel';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, testClient, closeTestClient } from './db.js';

// The same fixed test KEK as the other Vault suites on this database (the audit chain is keyed by it).
const config = new ConfigService({ DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_u4_vault_test', JWT_SECRET: 'x'.repeat(32), FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=' });
const stubMasterdata = { findMaterial: async () => null, findAliasForMaterial: async () => null, findAliasesForMaterials: async () => new Map(), searchMaterials: async () => [], matchMaterials: async () => [] };

let formulas: FormulasService;
let approvals: ApprovalsService;
before(async () => {
  await ensureSchema();
  const db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const vault = new VaultService(db as never, kms);
  formulas = new FormulasService(db as never, kms, vault, stubMasterdata);
  approvals = new ApprovalsService(db as never, vault);
});
afterAll(async () => { await closeTestClient(); });

const author = principal({ userId: uuidv7() });
const approver = principal({ userId: uuidv7() });

async function sealed(percentages: number[]) {
  const f = await formulas.createFormula({ formulaCode: `T5-${uuidv7()}`, formulaName: 'total probe' }, author);
  const v = await formulas.createVersion({ formulaId: f.formulaId, versionNumber: 1 }, author);
  await formulas.addIngredients(v.formulaVersionId, { ingredients: percentages.map((p, i) => ({ materialId: uuidv7(), percentage: p, sequenceNo: i + 1 })) }, author);
  return v.formulaVersionId;
}

test('STK-5: 99.96 % is refused at approval with the total and the difference, and stays undecided', async () => {
  const id = await sealed([50, 49.96]);
  await assert.rejects(() => approvals.approveVersion(id, {}, approver),
    (e: unknown) => e instanceof ConflictException && /total 99\.96%, 0\.04% short of 100%/.test((e as Error).message));
  const v = await formulas.getVersion(id);
  assert.notEqual(v!.status, 'APPROVED');
});

test('STK-5: over 100 % is refused too; exactly 100 % (six places) is approved', async () => {
  const over = await sealed([60, 40.000001]);
  await assert.rejects(() => approvals.approveVersion(over, {}, approver), /0\.000001% over 100%/);
  const ok = await sealed([33.333333, 33.333333, 33.333334]);
  await approvals.approveVersion(ok, {}, approver);
  assert.equal((await formulas.getVersion(ok))!.status, 'APPROVED');
});

test('STK-5: the refusal is audited without the total, the difference or any share', async () => {
  const id = await sealed([12.5]);
  await assert.rejects(() => approvals.approveVersion(id, {}, approver), ConflictException);
  const rows = await testClient()`select action, after::text as after from formula.audit_events where entity_id = ${id} and action = 'formula.version.approve.total_refused'`;
  assert.equal(rows.length, 1);
  const text = JSON.stringify(rows);
  assert.ok(!/12\.5|87\.5|%\s*short|short of/.test(text.replace('do not total 100 %', '')), text);
});
