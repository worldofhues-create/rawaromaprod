/**
 * RP-BE-1 (ALEMBIC LD-261) — the Vault box's Overview and Version-draft reads for the RAC OS Vault
 * console. Metadata only: the answer the relay carries holds no ingredient line, no material id from
 * inside a recipe, no percentage and no sealed payload; and every read is written to the hash-chained
 * formula.audit_events before it answers. The formula below is invented for this test.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { uuidv7 } from '@core/data-kernel';
import { sql } from 'drizzle-orm';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { VaultDeskService } from '../vault-desk/vault-desk.service.js';
import { VaultDeskController } from '../vault-desk/vault-desk.controller.js';
import { META_NO_RELAY } from '../../../backend-kernel/src/decorators/no-relay.decorator.js';
import { FormulasController } from '../formulas/formulas.controller.js';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/unused',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=',
});
const noMasterdata = { findMaterial: async () => null, findAliasForMaterial: async () => null, findAliasesForMaterials: async () => new Map(), searchMaterials: async () => [] };

const author = principal({ userId: uuidv7() });
const approver = principal({ userId: uuidv7() });
const reader = principal({ userId: uuidv7() });
const lineMaterialA = uuidv7();
const lineMaterialB = uuidv7();
let desk: VaultDeskService;
let db: ReturnType<typeof formulaDb>;
let formulaCode = '';
let approvedVersionId = '';
let reviewVersionId = '';

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const vault = new VaultService(db as never, kms);
  const formulas = new FormulasService(db as never, kms, vault, noMasterdata as never);
  const approvals = new ApprovalsService(db as never, vault);
  desk = new VaultDeskService(db as never, vault);
  formulaCode = `TFA-${uuidv7().slice(-10)}`;
  const f = await formulas.createFormula({ formulaCode, formulaName: 'TEST FORMULA A' }, author);
  const v1 = await formulas.createVersion({ formulaId: f.formulaId, versionNumber: 1 }, author);
  approvedVersionId = v1.formulaVersionId;
  await formulas.addIngredients(approvedVersionId, { ingredients: [{ materialId: lineMaterialA, percentage: 12.5, sequenceNo: 1 }, { materialId: lineMaterialB, percentage: 87.5, sequenceNo: 2 }] }, author);
  await approvals.approveVersion(approvedVersionId, { remarks: 'test approval' }, approver);
  const v2 = await formulas.createVersion({ formulaId: f.formulaId, versionNumber: 2 }, author);
  reviewVersionId = v2.formulaVersionId;
  await formulas.addIngredients(reviewVersionId, { ingredients: [{ materialId: lineMaterialA, percentage: 40, sequenceNo: 1 }, { materialId: lineMaterialB, percentage: 60, sequenceNo: 2 }] }, author);
  await approvals.submitForReview(reviewVersionId, {} as never, author);
});

afterAll(closeTestClient);

/** No ingredient line in what the relay would carry: no line material, no share, no sealed payload. */
function assertNoRecipe(answer: unknown) {
  const text = JSON.stringify(answer);
  for (const id of [lineMaterialA, lineMaterialB]) assert.ok(!text.includes(id), 'no material id from inside a recipe');
  for (const k of ['percentage', 'encPayload', 'enc_payload', 'encIv', 'encTag', 'ingredients', 'materialId', '12.5', '87.5']) {
    assert.ok(!text.includes(k), `no "${k}" in a relay-facing Vault read`);
  }
}

async function auditRows(action: string) {
  const r = await db.execute(sql`select actor_id::text as actor, entity_id::text as entity from formula.audit_events where action = ${action} and actor_id = ${reader.userId}::uuid`);
  return (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<{ actor: string; entity: string | null }>;
}

test('overview: tiles, the version waiting and the formula, as metadata; no ingredient line; audited first', async () => {
  const o = await desk.overview(reader);
  assert.ok(Number(o.tiles.approved) >= 1 && Number(o.tiles.waiting) >= 1);
  assert.equal(o.tiles.needed, null, 'main-box data: not invented on the Vault');
  const w = o.waiting.find((x) => x.formulaVersionId === reviewVersionId)!;
  assert.equal(w.formulaCode, formulaCode);
  assert.equal(w.formulaName, 'TEST FORMULA A');
  assert.equal(w.sealedLines, 2, 'a count of sealed lines, never the lines');
  const f = o.formulas.find((x) => x.formulaCode === formulaCode)!;
  assert.equal(f.approvedVersionId, approvedVersionId);
  assert.equal(f.latestVersionStatus, 'REVIEW');
  assertNoRecipe(o);
  assert.equal((await auditRows('formula.vault.overview_read')).length, 1);
});

test('version draft: the approved versions a draft may start from, metadata only; audited with the base', async () => {
  const d = await desk.versionDraft(reader, reviewVersionId);
  assert.deepEqual(d.bases.map((b) => b.formulaVersionId), [approvedVersionId], "only this formula's approved version");
  assert.equal(d.materials, null);
  assertNoRecipe(d);
  const rows = await auditRows('formula.vault.version_draft_read');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.entity, reviewVersionId);
});

test('the Vault desk reads are plain metadata routes; the decrypt and the line-carrying writes are @NoRelay', () => {
  const proto = VaultDeskController.prototype as unknown as Record<string, object>;
  for (const m of ['overview', 'versionDraft']) assert.notEqual(Reflect.getMetadata(META_NO_RELAY, proto[m]!), true);
  const paths = new Map<string, object>();
  for (const [, d] of Object.entries(Object.getOwnPropertyDescriptors(FormulasController.prototype))) {
    if (typeof d.value === 'function') {
      const p = Reflect.getMetadata('path', d.value);
      if (p) paths.set(`${Reflect.getMetadata('method', d.value)} ${p}`, d.value);
    }
  }
  for (const route of ['1 v1/formula-versions/:id/actual', '1 v1/formula-versions', '1 v1/formula-versions/:id/ingredients', '1 v1/formula-stages/:id/ingredients']) {
    const h = paths.get(route);
    assert.ok(h, `${route} exists`);
    assert.equal(Reflect.getMetadata(META_NO_RELAY, h!), true, `${route} is @NoRelay`);
  }
});
