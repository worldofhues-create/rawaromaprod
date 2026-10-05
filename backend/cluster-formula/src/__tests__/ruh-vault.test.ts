/**
 * Always-on Ruh on the Vault box (setup/ruh-vault.service.ts + the batch-approval route). Real
 * formula schema (this directory's harness), real Vault/Formulas/Approvals services.
 *
 *   warns:   approving at least N recipes at once (N pushed from the main box's Ruh settings) while
 *            the IFRA/allergen calculation shows warnings for some of their formulas, or is not
 *            configured at all → 409 RUH_CONFIRM_REQUIRED with the risks in NUMBERS; nothing approved;
 *   never blocks: with a typed reason the batch goes ahead exactly as before (every per-version rule
 *            still applies) and the override is kept (formula.ruh_override + the hash-chained audit);
 *   counts only: the sync the main box pulls carries the override (action, actor id, reason, risks)
 *            and the Vault's counts — never a formula id, code, name or product.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { MaterialCatalogue, materialCatalogueDigest } from '../facts-bridge/material-catalogue.js';
import { FormulaSetupService } from '../setup/formula-setup.service.js';
import { FormulaSetupController } from '../setup/formula-setup.controller.js';
import { RuhVaultService, RUH_BULK_MIN_KEY, RUH_VAULT_BULK_ACTION } from '../setup/ruh-vault.service.js';
import { approveBatchBody } from '../formula.dtos.js';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, testClient, closeTestClient } from './db.js';

const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const config = new ConfigService({ DATABASE_URL: 'postgres://unused/x', JWT_SECRET: 'x'.repeat(32), FORMULA_KEK: TEST_KEK });
const run = randomUUID().slice(0, 6).toUpperCase();
const material = { materialId: randomUUID(), materialCode: `RM-RUH-${run}`, materialName: `Ruh material ${run}` };
const ruhPrincipal = principal({ userId: randomUUID(), roles: ['formulator'], permissions: ['formula:formula_master:write', 'formula:formula_version:write', 'formula:formula_ingredients:write'] });
const approver = principal({ userId: randomUUID(), roles: ['vault_approver'] });

let setup: FormulaSetupService;
let ruh: RuhVaultService;
let controller: FormulaSetupController;
let vault: VaultService;
let priorAmendment: string | null | undefined;
const shells: Array<{ formulaId: string; formulaCode: string; productCode: string; versionId: string }> = [];

async function amendment(v: string | null) {
  await testClient()`insert into formula.compliance_setting (setting_key, setting_value) values ('ifra_amendment', ${v})
                     on conflict (setting_key) do update set setting_value = excluded.setting_value`;
}

before(async () => {
  await ensureSchema();
  const db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const catalogue = new MaterialCatalogue();
  catalogue.receive({ digest: materialCatalogueDigest([material]), materials: [material] });
  vault = new VaultService(db as never, kms);
  const formulas = new FormulasService(db as never, kms, vault, catalogue);
  const approvals = new ApprovalsService(db as never, vault);
  setup = new FormulaSetupService(db as never, kms, vault, formulas, approvals, catalogue);
  ruh = new RuhVaultService(db as never, vault);
  controller = new FormulaSetupController(setup, { recalculateFormulaInBackground() {} } as never, ruh);
  const products = Array.from({ length: 6 }, (_, i) => ({ productId: randomUUID(), productCode: `RUHB${i}-${run}`, productName: `Ruh bulk ${i}`, kind: 'single_chemical' as const, materialId: material.materialId }));
  const { results } = await setup.ensureShells({ products }, ruhPrincipal);
  results.forEach((r, i) => shells.push({ formulaId: r.formulaId!, formulaCode: r.formulaCode!, productCode: products[i]!.productCode, versionId: r.latestVersion!.formulaVersionId }));
  priorAmendment = ((await testClient()`select setting_value from formula.compliance_setting where setting_key = 'ifra_amendment'`)[0]?.setting_value ?? undefined) as string | null | undefined;
  await testClient()`delete from formula.compliance_setting where setting_key = ${RUH_BULK_MIN_KEY}`;
});

afterAll(async () => {
  if (priorAmendment === undefined) await testClient()`delete from formula.compliance_setting where setting_key = 'ifra_amendment'`;
  else await amendment(priorAmendment);
  await testClient()`delete from formula.compliance_setting where setting_key = ${RUH_BULK_MIN_KEY}`;
  await closeTestClient();
});

test('risks: fewer than the threshold, or no calculation warnings → none; many with warnings → one risk, in numbers', async () => {
  const ids = shells.map((s) => s.versionId);
  await amendment('51st');
  assert.deepEqual(await ruh.bulkApproveRisks(ids.slice(0, 4)), [], 'four is below the default five');
  assert.deepEqual(await ruh.bulkApproveRisks(ids), [], 'no warnings on file for these formulas');
  for (const s of shells.slice(0, 2)) {
    await testClient()`insert into formula.compliance_calc_status (formula_id, kind, outcome, missing_count)
                       values (${s.formulaId}, 'ifra', 'MISSING_DATA', 3) on conflict (formula_id, kind) do update set outcome = 'MISSING_DATA'`;
  }
  const [risk] = await ruh.bulkApproveRisks(ids);
  assert.equal(risk!.code, 'VAULT_BULK_APPROVE_CALC_WARNINGS');
  assert.equal(risk!.title, 'Approving 6 recipes at once while IFRA/allergen calculations show warnings');
  assert.match(risk!.detail, /^2 formulas of the 6 had an incomplete IFRA\/allergen calculation/);
  await amendment(null);
  assert.match((await ruh.bulkApproveRisks(ids))[0]!.detail, /IFRA amendment is not set/);
  await amendment('51st');
  // The threshold comes from the main box's Ruh settings, over the sync.
  await ruh.sync({ afterSeq: 0, limit: 1, bulkApproveMinVersions: 7 });
  assert.equal(await ruh.bulkMin(), 7);
  assert.deepEqual(await ruh.bulkApproveRisks(ids), [], 'six is below seven');
  await ruh.sync({ afterSeq: 0, limit: 1, bulkApproveMinVersions: 5 });
});

test('the batch approval warns without a reason (nothing approved), then goes ahead with one and keeps the override', async () => {
  const ids = shells.map((s) => s.versionId);
  assert.ok(approveBatchBody.safeParse({ versionIds: ids, ruhOverride: { reason: 'quarterly release' } }).success, 'the DTO accepts the reason');
  await assert.rejects(controller.approveBatch({ versionIds: ids }, approver), (e: unknown) => {
    assert.ok(e instanceof DomainError);
    assert.equal(e.code, 'RUH_CONFIRM_REQUIRED');
    assert.equal(e.status, 409);
    assert.equal((e.details as { action: string }).action, RUH_VAULT_BULK_ACTION);
    return true;
  });
  await assert.rejects(controller.approveBatch({ versionIds: ids, ruhOverride: { reason: 'short' } }, approver), /at least 8 characters/);
  const statuses = await testClient()`select status from formula.formula_version where formula_version_id in ${testClient()(ids)}`;
  assert.ok(statuses.every((s) => s.status === 'REVIEW'), 'nothing was approved');

  const [{ max }] = await testClient()`select coalesce(max(seq), 0)::int as max from formula.ruh_override` as unknown as [{ max: number }];
  const out = await controller.approveBatch({ versionIds: ids, ruhOverride: { reason: 'quarterly release, data follows' } }, approver);
  assert.equal(out.approved, 6, 'every per-version rule still applied, and all six passed them');
  const sync = await ruh.sync({ afterSeq: max, limit: 10, bulkApproveMinVersions: null });
  assert.equal(sync.overrides.length, 1);
  const o = sync.overrides[0]!;
  assert.equal(o.action, RUH_VAULT_BULK_ACTION);
  assert.equal(o.actorId, approver.userId);
  assert.equal(o.reason, 'quarterly release, data follows');
  assert.match(o.risks[0]!.detail, /Result: 6 approved, 0 not approved\.$/);
  const audit = await testClient()`select action, after from formula.audit_events where action = 'formula.ruh.override' and actor_id = ${approver.userId}::uuid`;
  assert.equal(audit.length, 1, 'on the hash-chained audit too');
  assert.equal((await vault.verifyAuditChain()).ok, true);

  // Counts only: nothing in what the main box receives identifies a formula or a product.
  const wire = JSON.stringify(sync);
  for (const s of shells) {
    assert.ok(!wire.includes(s.formulaId) && !wire.includes(s.formulaCode) && !wire.includes(s.productCode) && !wire.includes(s.versionId), 'no formula id / code / product on the wire');
  }
  assert.ok(!wire.includes(material.materialCode) && !wire.includes(material.materialName));
  assert.deepEqual(Object.keys(sync.counts).sort(), ['awaitingApproval', 'complianceWarnings', 'recipesNeeded']);
  assert.ok(sync.counts.complianceWarnings >= 2);
});

test('below the threshold the batch approval behaves exactly as before (no reason asked, nothing recorded)', async () => {
  const products = [0, 1].map((i) => ({ productId: randomUUID(), productCode: `RUHS${i}-${run}`, productName: `Ruh small ${i}`, kind: 'single_chemical' as const, materialId: material.materialId }));
  const { results } = await setup.ensureShells({ products }, ruhPrincipal);
  const [{ max }] = await testClient()`select coalesce(max(seq), 0)::int as max from formula.ruh_override` as unknown as [{ max: number }];
  const out = await controller.approveBatch({ versionIds: results.map((r) => r.latestVersion!.formulaVersionId) }, approver);
  assert.equal(out.approved, 2);
  assert.equal((await ruh.sync({ afterSeq: max, limit: 10, bulkApproveMinVersions: null })).overrides.length, 0);
});
