/**
 * IFRA + allergen certificates calculated in the Vault (owner ruling 2026-09-28, item 2) — real
 * Postgres (this directory's formula-schema harness, which also applies the migration's
 * `@target: formula` block), real VaultService/FormulasService/ApprovalsService/ComplianceService.
 * The material catalogue is a fake MasterdataLookup (on the Vault box it is the catalogue the main
 * box pushes).
 *
 *   import     CSV preview names every bad row (unknown material, CAS not on the list, bad %,
 *              bad category, RESTRICTED without max); a file with any error commits nothing.
 *   calculate  an approved formula's certificates hold exactly the hand-worked numbers; a
 *              recalculation that changes nothing stores nothing; a data change stores a new one;
 *              a new approved version gets a new opaque formulaVersionRef.
 *   missing    a material without data → no certificate, a count in the status, and its code/name
 *              in the (Vault-only) missing-data report and preview.
 *   leak       what the main box pulls carries numbers + the opaque ref + the formula id only —
 *              never a material id, an ingredient percentage or the version id.
 *   audit      every calculation's decrypt is on the hash-chained audit log.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import { auditEvents, complianceCertificate } from '@ra/data-formula';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { ComplianceService } from '../compliance/compliance.service.js';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/unused',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=',
});

// Unique per run: the compliance tables are shared with every other run against this database.
const RUN = uuidv7().slice(-8);
const M = { m1: uuidv7(), m2: uuidv7(), m3: uuidv7(), m4: uuidv7() };
const CODES = { [M.m1]: `CRM1-${RUN}`, [M.m2]: `CRM2-${RUN}`, [M.m3]: `CRM3-${RUN}`, [M.m4]: `CRM4-${RUN}` };
const catalogue = Object.entries(CODES).map(([materialId, materialCode]) => ({
  materialId, materialCode, materialName: `Raw material ${materialCode}`, uomId: null,
}));
const masterdata = {
  findMaterial: async (id: string) => catalogue.find((c) => c.materialId === id) ?? null,
  findAliasForMaterial: async () => null,
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async (q: string) => catalogue.filter((c) => c.materialCode.toLowerCase().includes(q.toLowerCase())),
};

let db: ReturnType<typeof formulaDb>;
let formulas: FormulasService;
let approvals: ApprovalsService;
let compliance: ComplianceService;
const author = principal({ userId: uuidv7() });
const approver = principal({ userId: uuidv7() });
const regulatory = principal({ userId: uuidv7(), roles: ['formulator'] });

const REFS_CSV = [
  'cas,name,sort_order',
  '138-86-3,Limonene,1',
  '78-70-6,Linalool,2',
  '5392-40-5,Citral,3',
  '91-64-5,Coumarin,4',
].join('\n');

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const vault = new VaultService(db as never, kms);
  formulas = new FormulasService(db as never, kms, vault, masterdata as never);
  approvals = new ApprovalsService(db as never, vault);
  compliance = new ComplianceService(db as never, kms, vault, masterdata as never);
  compliance.autoRecalculate = false;
  const refs = await compliance.importCsv('allergen_ref', REFS_CSV, true, regulatory);
  assert.equal(refs.committed, true, JSON.stringify(refs.rows.filter((r) => r.error)));
  await compliance.updateSettings({ reportingThresholdPct: 0, ifraAmendment: '51', allergenListRef: 'EU 26' }, regulatory);
});

afterAll(async () => {
  await compliance.idle();
  await closeTestClient();
});

async function approvedFormula(lines: { materialId: string; percentage: number }[]) {
  const f = await formulas.createFormula({ formulaCode: `CMP-${uuidv7()}`, formulaName: 'Compliance test' }, author);
  const v = await formulas.createVersion({ formulaId: f.formulaId, versionNumber: 1 }, author);
  await formulas.addIngredients(v.formulaVersionId, { ingredients: lines.map((l, i) => ({ ...l, sequenceNo: i + 1 })) }, author);
  await approvals.approveVersion(v.formulaVersionId, {}, approver);
  return { formulaId: f.formulaId, formulaVersionId: v.formulaVersionId };
}

const ALLERGEN_CSV = () => [
  'material_code,cas,natural_pct,synthetic_pct',
  `${CODES[M.m1]},138-86-3,5,0`,
  `${CODES[M.m1]},78-70-6,2,1`,
  `${CODES[M.m2]},138-86-3,0,10`,
  `${CODES[M.m2]},5392-40-5,0.01,0`,
  `${CODES[M.m3]},,,`, // declares: no regulated allergens
].join('\n');

const IFRA_CSV = () => [
  'material_code,amendment,category,restriction_type,max_pct',
  `${CODES[M.m1]},51,1,PROHIBITED,`,
  `${CODES[M.m1]},51,4,RESTRICTED,2`,
  `${CODES[M.m2]},51,4,RESTRICTED,6`,
  `${CODES[M.m2]},51,5A,RESTRICTED,1.5`,
  `${CODES[M.m2]},51,7A,RESTRICTED,0.5`,
  `${CODES[M.m3]},51,,,`, // declares: not restricted under amendment 51
].join('\n');

test('import preview: every bad row is named, and a file with any error commits nothing', async () => {
  const bad = [
    'material_code,cas,natural_pct,synthetic_pct',
    `NOPE-${RUN},138-86-3,1,0`, // unknown material
    `${CODES[M.m4]},106-24-1,1,0`, // valid CAS but not on the regulated list
    `${CODES[M.m4]},138-86-3,80,30`, // > 100 %
    `${CODES[M.m4]},91-64-5,1,0`,
    `${CODES[M.m4]},91-64-5,2,0`, // duplicate CAS
  ].join('\n');
  const preview = await compliance.importCsv('allergen', bad, true, regulatory);
  assert.equal(preview.committed, false);
  assert.equal(preview.errorCount, 4);
  assert.match(preview.rows[0]!.error!, /not in the material master/);
  assert.match(preview.rows[1]!.error!, /not on the regulated allergen list/);
  assert.match(preview.rows[2]!.error!, /exceeds 100/);
  assert.equal(preview.rows[3]!.error, undefined);
  assert.match(preview.rows[4]!.error!, /duplicate CAS/);
  assert.equal((await compliance.materialData(M.m4)).allergenComplete, false, 'nothing was written');

  const badIfra = [
    'material_code,amendment,category,restriction_type,max_pct',
    `${CODES[M.m4]},51,13,RESTRICTED,1`,
    `${CODES[M.m4]},51,4,RESTRICTED,`,
    `${CODES[M.m4]},51,5B,PROHIBITED,2`,
    `${CODES[M.m4]},,6,PROHIBITED,`,
  ].join('\n');
  const ifraPreview = await compliance.importCsv('ifra', badIfra, false, regulatory);
  assert.equal(ifraPreview.errorCount, 4);
  assert.match(ifraPreview.rows[0]!.error!, /not an IFRA category/);
  assert.match(ifraPreview.rows[1]!.error!, /needs max_pct/);
  assert.match(ifraPreview.rows[2]!.error!, /only a RESTRICTED row carries max_pct/);
  assert.match(ifraPreview.rows[3]!.error!, /amendment is required/);
});

test('import + calculate: an approved formula gets certificates with exactly the hand-worked numbers', async () => {
  const a = await compliance.importCsv('allergen', ALLERGEN_CSV(), false, regulatory);
  assert.equal(a.errorCount, 0, JSON.stringify(a.rows));
  assert.equal(a.committed, false, 'preview first');
  assert.equal((await compliance.importCsv('allergen', ALLERGEN_CSV(), true, regulatory)).committed, true);
  const i = await compliance.importCsv('ifra', IFRA_CSV(), true, regulatory);
  assert.equal(i.committed, true, JSON.stringify(i.rows.filter((r) => r.error)));

  const f = await approvedFormula([{ materialId: M.m1, percentage: 20 }, { materialId: M.m2, percentage: 30 }, { materialId: M.m3, percentage: 50 }]);
  const outcome = await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
  assert.deepEqual(outcome.results.map((r) => [r.kind, r.outcome]), [['ifra', 'CERTIFIED'], ['allergen', 'CERTIFIED']]);

  const certs = await db.select().from(complianceCertificate).where(eq(complianceCertificate.formulaId, f.formulaId));
  const ifra = certs.find((c) => c.kind === 'ifra')!;
  const allergen = certs.find((c) => c.kind === 'allergen')!;
  assert.equal(ifra.amendment, '51');
  assert.equal(allergen.amendment, 'EU 26');
  const limits = Object.fromEntries((ifra.certValues as { category: string; limitPct: number }[]).map((v) => [v.category, v.limitPct]));
  assert.equal(limits['1'], 0); // M1 prohibited
  assert.equal(limits['4'], 10); // min(2/20, 6/30) × 100
  assert.equal(limits['5A'], 5); // 1.5/30 × 100
  assert.equal(limits['7A'], 1.66); // 0.5/30 × 100, floored
  assert.equal(limits['12'], 100);
  assert.deepEqual(allergen.certValues, [
    { name: 'Limonene', cas: '138-86-3', natural: 1, synthetic: 3, total: 4 },
    { name: 'Linalool', cas: '78-70-6', natural: 0.4, synthetic: 0.2, total: 0.6 },
    { name: 'Citral', cas: '5392-40-5', natural: 0.003, synthetic: 'A', total: 0.003 },
    { name: 'Coumarin', cas: '91-64-5', natural: 'A', synthetic: 'A', total: 'A' },
  ]);
  assert.match(ifra.formulaVersionRef, /^fvr_[0-9a-f]{32}$/);
  assert.equal(ifra.formulaVersionRef, allergen.formulaVersionRef);
  assert.notEqual(ifra.formulaVersionRef, f.formulaVersionId);

  // The decrypt behind it is on the hash-chained audit log.
  const audit = await db.select().from(auditEvents)
    .where(and(eq(auditEvents.action, 'formula.compliance.calculate'), eq(auditEvents.entityId, f.formulaVersionId)));
  assert.ok(audit.length >= 1);
});

test('what the main box pulls: numbers + opaque ref + formula id only — never a material, a percentage or the version id', async () => {
  const f = await approvedFormula([{ materialId: M.m1, percentage: 37.5 }, { materialId: M.m3, percentage: 62.5 }]);
  await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
  const seqs = (await db.select().from(complianceCertificate).where(eq(complianceCertificate.formulaId, f.formulaId))).map((c) => Number(c.seq));
  const pulled = (await compliance.certificatesAfter(Math.min(...seqs) - 1, 200)).filter((c) => c.formulaId === f.formulaId);
  assert.equal(pulled.length, 2);
  for (const c of pulled) {
    assert.deepEqual(Object.keys(c).sort(), ['amendment', 'calculatedAt', 'certificateId', 'formulaId', 'formulaVersionRef', 'kind', 'seq', 'values']);
    const json = JSON.stringify(c);
    for (const secret of [M.m1, M.m3, f.formulaVersionId, '37.5', '62.5']) assert.ok(!json.includes(secret), `leaked ${secret}`);
  }
});

test('an unchanged recalculation stores nothing; a data change stores a new certificate', async () => {
  const f = await approvedFormula([{ materialId: M.m1, percentage: 20 }, { materialId: M.m2, percentage: 30 }, { materialId: M.m3, percentage: 50 }]);
  await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
  const count = async () => (await db.select().from(complianceCertificate).where(eq(complianceCertificate.formulaId, f.formulaId))).length;
  assert.equal(await count(), 2);
  const again = await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
  assert.deepEqual(again.results.map((r) => r.outcome), ['UNCHANGED', 'UNCHANGED']);
  assert.equal(await count(), 2);

  // M2's limonene goes from 10 % to 20 % synthetic: the allergen certificate changes, IFRA does not.
  const m2 = await compliance.materialData(M.m2);
  await compliance.saveMaterialData(M.m2, {
    allergenComplete: true, ifraComplete: true, ifraAmendment: '51',
    allergens: m2.allergens.map((x) => (x.cas === '138-86-3' ? { ...x, syntheticPct: 20 } : x)),
    ifra: m2.ifra.map((r) => ({ ...r, restrictionType: r.restrictionType as 'RESTRICTED' })),
  }, regulatory);
  const changed = await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
  assert.deepEqual(changed.results.map((r) => [r.kind, r.outcome]), [['ifra', 'UNCHANGED'], ['allergen', 'CERTIFIED']]);
  assert.equal(await count(), 3);
  // Restore for the other tests' hand-worked numbers.
  await compliance.importCsv('allergen', ALLERGEN_CSV(), true, regulatory);
});

test('a newly approved version is recalculated under a new opaque formulaVersionRef', async () => {
  const f = await approvedFormula([{ materialId: M.m1, percentage: 20 }, { materialId: M.m3, percentage: 80 }]);
  await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
  const v2 = await formulas.createVersion({ formulaId: f.formulaId, versionNumber: 2 }, author);
  await formulas.addIngredients(v2.formulaVersionId, { ingredients: [{ materialId: M.m1, percentage: 40, sequenceNo: 1 }, { materialId: M.m3, percentage: 60, sequenceNo: 2 }] }, author);
  await approvals.approveVersion(v2.formulaVersionId, {}, approver);
  await compliance.recalculateFormula(f.formulaId, 'version_approved', approver.userId);
  const refs = new Set((await db.select().from(complianceCertificate).where(eq(complianceCertificate.formulaId, f.formulaId))).map((c) => c.formulaVersionRef));
  const v1Ref = await compliance.formulaVersionRef(f.formulaVersionId);
  const v2Ref = await compliance.formulaVersionRef(v2.formulaVersionId);
  assert.notEqual(v1Ref, v2Ref);
  assert.deepEqual(refs, new Set([v1Ref, v2Ref]));
});

test('missing data: no certificate, a count in the status, and the material named in the Vault-only report', async () => {
  const f = await approvedFormula([{ materialId: M.m1, percentage: 50 }, { materialId: M.m4, percentage: 50 }]);
  const outcome = await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
  assert.deepEqual(outcome.results.map((r) => [r.kind, r.outcome, r.missingCount]), [['ifra', 'MISSING_DATA', 1], ['allergen', 'MISSING_DATA', 1]]);
  assert.equal((await db.select().from(complianceCertificate).where(eq(complianceCertificate.formulaId, f.formulaId))).length, 0);

  const preview = await compliance.preview(f.formulaId, regulatory);
  assert.equal(preview.ifra.ok, false);
  assert.deepEqual(!preview.allergen.ok && preview.allergen.missingMaterials, [{ materialCode: CODES[M.m4], materialName: `Raw material ${CODES[M.m4]}` }]);
  const report = await compliance.missingDataReport(regulatory);
  const row = report.materials.find((m) => m.materialCode === CODES[M.m4]);
  assert.ok(row, 'M4 is in the missing-data report');
  assert.equal(row!.missingIfra, true);
  assert.equal(row!.missingAllergen, true);
  assert.ok(!JSON.stringify(report).includes(M.m4), 'the report names materials by code/name, never by id');
});

test('IFRA amendment changes → data declared for the old amendment counts as missing until re-entered', async () => {
  const f = await approvedFormula([{ materialId: M.m1, percentage: 20 }, { materialId: M.m2, percentage: 30 }, { materialId: M.m3, percentage: 50 }]);
  await compliance.updateSettings({ ifraAmendment: '52' }, regulatory);
  try {
    const outcome = await compliance.recalculateFormula(f.formulaId, 'test', regulatory.userId);
    assert.deepEqual(outcome.results.find((r) => r.kind === 'ifra'), { kind: 'ifra', outcome: 'MISSING_DATA', missingCount: 3 });
    assert.equal(outcome.results.find((r) => r.kind === 'allergen')!.outcome, 'CERTIFIED');
  } finally {
    await compliance.updateSettings({ ifraAmendment: '51' }, regulatory);
  }
});
