/**
 * FormulaDirectoryService (lane fread-rp) — what the Vault answers the main box's non-recipe reads
 * with (dashboard runs, the finished-good trace, the formula-access audit) and what the Vault
 * console's access-audit screen reads. Real Postgres (this directory's formula-schema harness),
 * real FormulasService/ApprovalsService to create the data.
 *
 * Proves: a version's label is its formula CODE + version number + status; the dashboard's recent
 * block is codes + event TYPES and times; the formula NAME and an approver's REMARKS never appear
 * anywhere in the answer; the access audit is the hash-chained audit_events rows with reason/result
 * and the same limit/cursor bounds the main box always applied.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7 } from '@core/data-kernel';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { FormulaDirectoryService, accessAuditBounds } from '../formula-directory.service.js';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/unused',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=',
});
const noMasterdata = {
  findMaterial: async () => null,
  findAliasForMaterial: async () => null,
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async () => [],
};

const SECRET_NAME = `Secret Oud Accord ${uuidv7()}`;
const SECRET_REMARK = `reduce ingredient to 2.5% ${uuidv7()}`;
const author = principal({ userId: uuidv7() });
const approver = principal({ userId: uuidv7() });

let directory: FormulaDirectoryService;
let formulaId = '';
let formulaCode = '';
let versionId = '';

before(async () => {
  await ensureSchema();
  const db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const vault = new VaultService(db as any, kms);
  const formulas = new FormulasService(db as any, kms, vault, noMasterdata as any);
  const approvals = new ApprovalsService(db as any, vault);
  directory = new FormulaDirectoryService(db as any);

  formulaCode = `DIR-${uuidv7().slice(-12)}`;
  const f = await formulas.createFormula({ formulaCode, formulaName: SECRET_NAME }, author);
  formulaId = f.formulaId;
  const v = await formulas.createVersion({ formulaId, versionNumber: 3 }, author);
  versionId = v.formulaVersionId;
  await formulas.addIngredients(versionId, { ingredients: [{ materialId: uuidv7(), percentage: 2.5, sequenceNo: 1 }] }, author);
  await approvals.approveVersion(versionId, { remarks: SECRET_REMARK }, approver);
});

afterAll(async () => {
  await closeTestClient();
});

test('labels: a version is its formula code + version number + status, a formula its code — no name', async () => {
  const labels = await directory.labels({ formulaVersionIds: [versionId, uuidv7()], formulaIds: [formulaId, uuidv7()] });
  assert.deepEqual(labels.versions, [{ formulaVersionId: versionId, formulaId, formulaCode, versionNumber: 3, status: 'APPROVED' }]);
  assert.deepEqual(labels.formulas, [{ formulaId, formulaCode }]);
  assert.equal(labels.recent, null, 'the recent block only when asked');
  assert.doesNotMatch(JSON.stringify(labels), new RegExp(SECRET_NAME));
});

test('labels (recent): formula codes and lifecycle event types/times — never names or remarks', async () => {
  const labels = await directory.labels({ formulaVersionIds: [], formulaIds: [], recent: true });
  assert.ok(labels.recent);
  assert.ok(labels.recent.formulaCodes.length >= 1 && labels.recent.formulaCodes.length <= 3);
  for (const c of labels.recent.formulaCodes) assert.equal(typeof c, 'string');
  assert.ok(labels.recent.events.length >= 1 && labels.recent.events.length <= 5);
  assert.equal(labels.recent.events[0]!.eventType, 'VERSION_APPROVED', 'newest first');
  assert.deepEqual(Object.keys(labels.recent.events[0]!).sort(), ['eventDt', 'eventType']);
  assert.ok(!Number.isNaN(Date.parse(labels.recent.events[0]!.eventDt!)));
  const wire = JSON.stringify(labels);
  assert.doesNotMatch(wire, new RegExp(SECRET_NAME));
  assert.doesNotMatch(wire, new RegExp(SECRET_REMARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('labels: no ids and no recent block is an empty answer, not a query for everything', async () => {
  assert.deepEqual(await directory.labels({ formulaVersionIds: [], formulaIds: [] }), { versions: [], formulas: [], recent: null });
});

test('accessAudit: the hash-chained rows, newest first, with reason/result and no actor email', async () => {
  const page = await directory.accessAudit(500);
  const created = page.items.find((r) => r.action === 'formula.created' && r.entityId === formulaId);
  assert.ok(created, 'the formula.created row of this formula');
  assert.equal(created.actorId, author.userId);
  assert.equal(created.actor, null);
  assert.equal(created.result, 'allow');
  assert.deepEqual(Object.keys(created).sort(),
    ['action', 'actor', 'actorId', 'entityId', 'entityType', 'id', 'ip', 'occurredAt', 'reason', 'requestId', 'result']);
  const times = page.items.map((r) => Date.parse(r.occurredAt));
  assert.deepEqual([...times].sort((a, b) => b - a), times, 'newest first');
});

test('accessAudit: offset paging and the main box\'s old bounds (limit 1..500, a bad cursor reads as 0)', async () => {
  const first = await directory.accessAudit(1);
  assert.equal(first.items.length, 1);
  assert.equal(first.nextCursor, '1');
  const second = await directory.accessAudit(1, first.nextCursor);
  assert.notEqual(second.items[0]!.id, first.items[0]!.id);
  assert.deepEqual(accessAuditBounds(0, 'junk'), { limit: 100, offset: 0 });
  assert.deepEqual(accessAuditBounds(9999, '-5'), { limit: 500, offset: 0 });
  assert.deepEqual(accessAuditBounds(200, '400'), { limit: 200, offset: 400 });
  assert.deepEqual(accessAuditBounds(10, '99999999999'), { limit: 10, offset: 999_999_999 }, 'fits the channel\'s 9 digits');
});
