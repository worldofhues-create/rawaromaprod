/**
 * VF-FIX (ALEMBIC LD-261) — GET /v1/formulas/:id/versions on the Vault box: one formula's versions for the RAC OS
 * Vault console's Versions tab, which had no route ("Not on this server yet"). Per version: its number, state, who
 * created and who approved it, and when. METADATA ONLY: no line, no quantity, no ingredient name or material id, no
 * sealed payload; the read is written to the hash-chained formula.audit_events before it answers, as the other Vault
 * desk reads are. Permission: the formula's own read (formula:formula_master:read). The formula is invented here.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { uuidv7 } from '@core/data-kernel';
import { sql } from 'drizzle-orm';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { META_NO_RELAY } from '../../../backend-kernel/src/decorators/no-relay.decorator.js';
import { EnvKmsAdapter } from '../../../cluster-formula/src/crypto/env-kms.adapter.js';
import { VaultService } from '../../../cluster-formula/src/vault.service.js';
import { FormulasService } from '../../../cluster-formula/src/formulas/formulas.service.js';
import { ApprovalsService } from '../../../cluster-formula/src/approvals/approvals.service.js';
import { VaultDeskService } from '../../../cluster-formula/src/vault-desk/vault-desk.service.js';
import { VaultDeskController } from '../../../cluster-formula/src/vault-desk/vault-desk.controller.js';
import { ensureSchema, formulaDb, closeTestClient } from '../../../cluster-formula/src/__tests__/db.js';
import { principal } from '../../../test-support/db.js';

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
let formulaId = '';
let otherFormulaId = '';
let v1 = '';
let v2 = '';

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const vault = new VaultService(db as never, kms);
  const formulas = new FormulasService(db as never, kms, vault, noMasterdata as never);
  const approvals = new ApprovalsService(db as never, vault);
  desk = new VaultDeskService(db as never, vault);
  const f = await formulas.createFormula({ formulaCode: `TVV-${uuidv7().slice(-10)}`, formulaName: 'TEST FORMULA VERSIONS' }, author);
  formulaId = f.formulaId;
  const a = await formulas.createVersion({ formulaId, versionNumber: 1 }, author);
  v1 = a.formulaVersionId;
  await formulas.addIngredients(v1, { ingredients: [{ materialId: lineMaterialA, percentage: 12.5, sequenceNo: 1 }, { materialId: lineMaterialB, percentage: 87.5, sequenceNo: 2 }] }, author);
  await approvals.approveVersion(v1, { remarks: 'test approval' }, approver);
  const b = await formulas.createVersion({ formulaId, versionNumber: 2 }, author);
  v2 = b.formulaVersionId;
  await formulas.addIngredients(v2, { ingredients: [{ materialId: lineMaterialA, percentage: 40, sequenceNo: 1 }, { materialId: lineMaterialB, percentage: 60, sequenceNo: 2 }] }, author);
  await approvals.submitForReview(v2, {} as never, author);
  const other = await formulas.createFormula({ formulaCode: `TVO-${uuidv7().slice(-10)}`, formulaName: 'ANOTHER FORMULA' }, author);
  otherFormulaId = other.formulaId;
  await formulas.createVersion({ formulaId: otherFormulaId, versionNumber: 1 }, author);
});
afterAll(closeTestClient);

test('versions: this formula only, newest first, each with number, state, who created and approved it, and when', async () => {
  const r = await desk.formulaVersions(reader, formulaId);
  assert.deepEqual(r.items.map((x) => x.formulaVersionId), [v2, v1], 'newest first, no version of another formula');
  const [two, one] = r.items;
  assert.deepEqual([two!.versionNumber, two!.status, two!.createdBy, two!.approvedBy, two!.approvedDt], [2, 'REVIEW', author.userId, null, null]);
  assert.equal(one!.versionNumber, 1);
  assert.equal(one!.createdBy, author.userId);
  assert.equal(one!.approvedBy, approver.userId);
  assert.ok(one!.createdDt && one!.approvedDt, 'when it was created and approved');
  assert.equal(r.total, 2);
});

test('versions: metadata only: no line, no quantity, no ingredient or material, no sealed payload', async () => {
  const r = await desk.formulaVersions(reader, formulaId);
  const text = JSON.stringify(r);
  for (const id of [lineMaterialA, lineMaterialB]) assert.ok(!text.includes(id), 'no material id from inside a recipe');
  for (const k of ['percentage', 'encPayload', 'enc_payload', 'encIv', 'encTag', 'ingredient', 'materialId', 'materialName', 'quantity', 'Mg"', '12.5', '87.5', 'sealedLines', 'lines']) {
    assert.ok(!text.includes(k), `no "${k}" in the versions read`);
  }
  assert.deepEqual(Object.keys(r.items[0]!).sort(), ['approvedBy', 'approvedDt', 'createdBy', 'createdDt', 'formulaVersionId', 'status', 'versionNumber']);
});

test('versions: written to the Vault audit before answering; an unknown or malformed formula is a 404 or 400, never another formula', async () => {
  const before = await audited();
  await desk.formulaVersions(reader, formulaId);
  assert.equal((await audited()).length, before.length + 1);
  assert.equal((await audited()).at(-1)!.entity, formulaId);
  await assert.rejects(desk.formulaVersions(reader, uuidv7()), /No formula/);
  await assert.rejects(desk.formulaVersions(reader, 'not-a-uuid'), /formula id/);
});

async function audited() {
  const r = await db.execute(sql`select entity_id::text as entity from formula.audit_events where action = 'formula.vault.versions_read' and actor_id = ${reader.userId}::uuid order by chain_seq`);
  return (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<{ entity: string | null }>;
}

test('versions: the formula\'s own read permission, a plain metadata route the relay may call', () => {
  const proto = VaultDeskController.prototype as unknown as Record<string, object>;
  assert.ok(proto.formulaVersions, 'the route exists');
  assert.equal(Reflect.getMetadata('path', proto.formulaVersions!), 'v1/formulas/:id/versions');
  assert.notEqual(Reflect.getMetadata(META_NO_RELAY, proto.formulaVersions!), true);
  const guard = new PermissionsGuard(new Reflector());
  const can = (permissions: string[]) => {
    const ctx = { getHandler: () => proto.formulaVersions, getClass: () => VaultDeskController, switchToHttp: () => ({ getRequest: () => ({ user: principal({ permissions }) }) }) };
    try { return guard.canActivate(ctx as never) === true; } catch { return false; }
  };
  assert.equal(can(['formula:formula_master:read']), true);
  assert.equal(can(['formula:formula_version:read']), false, 'the same permission as GET /v1/formulas/:id, no other');
  assert.equal(can([]), false);
});
