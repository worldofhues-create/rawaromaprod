/**
 * Lane vaultsetup — the Vault box's formula setup (setup/formula-setup.service.ts) against a real
 * formula schema (this directory's db.ts harness), the real Vault/Formulas/Approvals services, and
 * the real Vault-box material catalogue (MaterialCatalogue, filled the way the main box pushes it).
 *
 *   shells     one per product, idempotent (a re-run, and a racing duplicate, get the same shell);
 *              single_chemical sealed at exactly [{ its material, 100 %, seq 1 }] and in REVIEW;
 *              blend left an empty DRAFT ("recipe needed").
 *   SoD        the shell's author (Ruh) can never approve it; whoever SEALED a recipe can never
 *              approve it either (even holding the approval permission); a third person can.
 *   import     deterministic parse + exact matching: unmatched names (with suggestions), ambiguous
 *              names, duplicates, ≤ 0 blocks, a total ≠ 100 warns; nothing is written by a preview
 *              or by a commit that has any blocking problem; a clean commit seals AS THE UPLOADER
 *              into the shell's DRAFT, records stages, and submits for review.
 *   approvals  the review queue says who may not approve what; approveMany approves each version
 *              in its own transaction with its own audit row naming the human; a refused row does
 *              not stop the others.
 *   routes     the setup routes' guards: drafting needs all three formulator write permissions,
 *              the import needs the seal permission (a vault_approver cannot upload), the batch
 *              approval needs the approval permission AND a fresh sign-in.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { Reflector } from '@nestjs/core';
import * as formulaSchema from '@ra/data-formula';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { PermissionsGuard } from '../../../backend-kernel/src/edge/permissions.guard.js';
import { FreshAuthGuard } from '../../../backend-kernel/src/edge/fresh-auth.guard.js';
import { DomainError } from '../../../backend-kernel/src/edge/domain-error.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { MaterialCatalogue, materialCatalogueDigest, type MaterialCatalogueEntry } from '../facts-bridge/material-catalogue.js';
import { FormulaSetupService, shellFormulaCode } from '../setup/formula-setup.service.js';
import { FormulaSetupController } from '../setup/formula-setup.controller.js';
import { principal } from '../../../test-support/db.js';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const { auditEvents, formulaVersion, formulaIngredients, formulaStageMaster, formulaEventHist, formulaApproval } = formulaSchema;

// Same fixed KEK as the other files on this harness (the audit chain's HMAC must stay consistent).
const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const config = new ConfigService({ DATABASE_URL: 'postgres://unused/x', JWT_SECRET: 'x'.repeat(32), FORMULA_KEK: TEST_KEK });

let db: ReturnType<typeof formulaDb>;
let vault: VaultService;
let formulas: FormulasService;
let approvals: ApprovalsService;
let setup: FormulaSetupService;
const catalogue = new MaterialCatalogue();

const run = randomUUID().slice(0, 6).toUpperCase();
const mat = (code: string, name: string): MaterialCatalogueEntry => ({ materialId: randomUUID(), materialCode: `${code}-${run}`, materialName: `${name} ${run}` });
const M = {
  linalool: mat('RM-LIN', 'Linalool'),
  hedione: mat('RM-HED', 'Hedione'),
  iso: mat('RM-ISO', 'Iso E Super'),
  ambroxA: mat('RM-AMB1', 'Ambrox'),
  ambroxB: { materialId: randomUUID(), materialCode: `RM-AMB2-${run}`, materialName: `Ambrox ${run}` }, // same name as ambroxA
  single: mat('BENZ', 'Benzyl Acetate'),
};

/** Ruh — the service principal that drafts the shells (its token carries the three drafting perms). */
const ruh = principal({ userId: randomUUID(), roles: ['formulator'], permissions: ['formula:formula_master:write', 'formula:formula_version:write', 'formula:formula_ingredients:write'] });
/** A human formulator who uploads recipes. */
const formulator = principal({ userId: randomUUID(), roles: ['formulator'] });
/** The one person who approves. */
const approver = principal({ userId: randomUUID(), roles: ['vault_approver'] });

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new EnvKmsAdapter(config);
  const all = Object.values(M);
  catalogue.receive({ digest: materialCatalogueDigest(all), materials: all });
  vault = new VaultService(db as never, kms);
  formulas = new FormulasService(db as never, kms, vault, catalogue);
  approvals = new ApprovalsService(db as never, vault);
  setup = new FormulaSetupService(db as never, kms, vault, formulas, approvals, catalogue);
});

afterAll(async () => {
  await closeTestClient();
});

const product = (code: string, kind: 'single_chemical' | 'blend', materialId?: string) => ({
  productId: randomUUID(),
  productCode: `${code}-${run}`,
  productName: `${code} product`,
  kind,
  ...(materialId ? { materialId } : {}),
});

async function versionsOf(formulaId: string) {
  return db.select().from(formulaVersion).where(eq(formulaVersion.formulaId, formulaId));
}

/* ── shells ─────────────────────────────────────────────────────────────────────────────── */

test('shells: a single-chemical product is sealed at exactly 100 % of its own material and submitted for review', async () => {
  const p = product('SC', 'single_chemical', M.single.materialId);
  const { results } = await setup.ensureShells({ products: [p] }, ruh);
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.outcome, 'created', r.error);
  assert.equal(r.formulaCode, shellFormulaCode(p.productCode));
  assert.equal(r.kind, 'single_chemical');
  assert.equal(r.state, 'in_review');
  assert.deepEqual({ n: r.latestVersion?.versionNumber, s: r.latestVersion?.status, sealed: r.latestVersion?.sealedCount }, { n: 1, s: 'REVIEW', sealed: 1 });

  const [v] = await versionsOf(r.formulaId!);
  assert.equal(v!.createdBy, ruh.userId, 'Ruh is the version\'s author');
  assert.equal(v!.submittedBy, ruh.userId);
  const sealed = await db.select().from(formulaIngredients).where(eq(formulaIngredients.formulaVersionId, v!.formulaVersionId));
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0]!.createdBy, ruh.userId);
  assert.equal(sealed[0]!.sequenceNo, 1);

  // Approved by a human, the sealed recipe decrypts to exactly one line: the material at 100 %.
  await approvals.approveVersion(v!.formulaVersionId, {}, approver);
  const recipe = await vault.decryptVersion(v!.formulaVersionId, { actorId: approver.userId, action: 'formula.test.read', entityType: 'formula_version', entityId: v!.formulaVersionId });
  assert.deepEqual(recipe, [{ materialId: M.single.materialId, percentage: 100, sequenceNo: 1 }]);
});

test('shells: a blend is left an empty DRAFT — "recipe needed" — and appears in the recipes list', async () => {
  const p = product('BL', 'blend');
  const { results } = await setup.ensureShells({ products: [p] }, ruh);
  const r = results[0]!;
  assert.equal(r.outcome, 'created', r.error);
  assert.equal(r.state, 'recipe_needed');
  assert.deepEqual({ s: r.latestVersion?.status, sealed: r.latestVersion?.sealedCount }, { s: 'DRAFT', sealed: 0 });
  const listed = (await setup.recipes()).find((x) => x.productId === p.productId);
  assert.equal(listed?.state, 'recipe_needed');
  assert.equal(listed?.kind, 'blend');
  const hist = await db.select().from(formulaEventHist).where(eq(formulaEventHist.formulaId, r.formulaId!));
  assert.ok(hist.some((h) => h.eventType === 'RECIPE_NEEDED'));
  const audit = await db.select().from(auditEvents).where(and(eq(auditEvents.entityId, r.formulaId!), eq(auditEvents.action, 'formula.shell.drafted')));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actorId, ruh.userId);
});

test('shells: a duplicate that lost the race after its first look gets the existing shell, not an error', async () => {
  // The window the concurrent test only sometimes hits: the first look finds no shell, the other request
  // commits, and this one then meets its own formula code. Forced here so it fails every time if it regresses.
  const p = product('RACE', 'blend');
  const first = (await setup.ensureShells({ products: [p] }, ruh)).results[0]!;
  assert.equal(first.outcome, 'created');
  const svc = setup as unknown as { viewsFor: (q: unknown) => Promise<unknown[]> };
  const real = svc.viewsFor;
  let looks = 0;
  svc.viewsFor = function (this: unknown, q: unknown) { looks += 1; return looks === 1 ? Promise.resolve([]) : real.call(this, q); };
  try {
    const second = (await setup.ensureShells({ products: [p] }, ruh)).results[0]!;
    assert.equal(second.outcome, 'existing', second.error);
    assert.equal(second.formulaId, first.formulaId);
  } finally { delete (svc as { viewsFor?: unknown }).viewsFor; }
});

test('shells: idempotent — a re-run (and a concurrent duplicate) returns the same shell, never a second formula', async () => {
  const p = product('IDEM', 'blend');
  const [a, b] = await Promise.all([setup.ensureShells({ products: [p] }, ruh), setup.ensureShells({ products: [p] }, ruh)]);
  const ids = [a.results[0]!, b.results[0]!];
  assert.deepEqual(ids.map((x) => x.outcome).sort(), ['created', 'existing']);
  assert.equal(ids[0]!.formulaId, ids[1]!.formulaId);
  const again = await setup.ensureShells({ products: [{ ...p, kind: 'single_chemical', materialId: M.single.materialId }] }, ruh);
  assert.equal(again.results[0]!.outcome, 'existing');
  assert.equal(again.results[0]!.formulaId, ids[0]!.formulaId);
  assert.equal(again.results[0]!.kind, 'blend', 'an existing shell is returned as it is');
  assert.equal((await versionsOf(ids[0]!.formulaId!)).length, 1);
});

test('shells: refusals are per product — a single chemical without (or with an unknown) material, a taken formula code', async () => {
  const noMaterial = product('NOMAT', 'single_chemical');
  const unknownMaterial = product('UNK', 'single_chemical', randomUUID());
  const ok = product('OK', 'blend');
  const taken = product('TAKEN', 'blend');
  await formulas.createFormula({ formulaCode: shellFormulaCode(taken.productCode), formulaName: 'already there' }, formulator);
  const { results } = await setup.ensureShells({ products: [noMaterial, unknownMaterial, ok, taken] }, ruh);
  assert.deepEqual(results.map((r) => r.outcome), ['error', 'error', 'created', 'error']);
  assert.match(results[0]!.error!, /needs its own material/);
  assert.match(results[1]!.error!, /not in the material catalogue/);
  assert.match(results[3]!.error!, /already used by another formula/);
});

/* ── SoD ────────────────────────────────────────────────────────────────────────────────── */

test('SoD: Ruh (the shell\'s author) can never approve its own shell, even holding the approval permission', async () => {
  const p = product('RUHSELF', 'single_chemical', M.single.materialId);
  const r = (await setup.ensureShells({ products: [p] }, ruh)).results[0]!;
  const ruhWithApproval = { ...ruh, permissions: [...ruh.permissions, 'formula:formula_approval:write'] };
  await assert.rejects(() => approvals.approveVersion(r.latestVersion!.formulaVersionId, {}, ruhWithApproval), /segregation of duties/);
  const [v] = await versionsOf(r.formulaId!);
  assert.equal(v!.status, 'REVIEW');
});

/* ── recipe import ──────────────────────────────────────────────────────────────────────── */

test('import preview: matched, unmatched (with suggestions), ambiguous, duplicate, ≤ 0 and total ≠ 100 — nothing written', async () => {
  const blend = (await setup.ensureShells({ products: [product('PRE', 'blend')] }, ruh)).results[0]!;
  const code = blend.productCode;
  const csv = [
    'product_code,material,percentage',
    `${code},${M.linalool.materialCode},40`,
    `${code},hedione ${run.toLowerCase()},30`, // name, case-insensitive
    `${code},Linalol ${run},10`, // typo -> unmatched, suggestions
    `${code},Ambrox ${run},5`, // two materials share this name -> ambiguous
    `${code},${M.linalool.materialCode},5`, // duplicate of line 2
    `${code},${M.iso.materialCode},0`, // ≤ 0
    `NOPE-${run},${M.iso.materialCode},10`, // unknown product
  ].join('\n');
  const before = await db.select().from(formulaIngredients).where(eq(formulaIngredients.formulaVersionId, blend.latestVersion!.formulaVersionId));
  const res = await setup.importRecipes({ csv, commit: false, submit: true }, formulator);
  assert.equal(res.committed, false);
  const byLine = new Map(res.rows.map((r) => [r.line, r]));
  assert.equal(byLine.get(2)!.materialId, M.linalool.materialId);
  assert.equal(byLine.get(2)!.error, null);
  assert.equal(byLine.get(3)!.materialId, M.hedione.materialId);
  assert.match(byLine.get(4)!.error!, /no material with code or name "Linalol/);
  assert.ok(Array.isArray(byLine.get(4)!.suggestions));
  assert.match(byLine.get(5)!.error!, /matches 2 materials — use the material code/);
  assert.match(byLine.get(7)!.error!, /greater than 0/);
  assert.match(byLine.get(8)!.error!, /no formula shell for product/);
  const recipe = res.recipes.find((x) => x.formulaId === blend.formulaId)!;
  assert.ok(recipe.errors.some((e) => /line 6 repeats the material on line 2/.test(e)));
  assert.ok(recipe.warnings.some((w) => /add up to 90%, not 100%/.test(w)), recipe.warnings.join(';'));
  assert.ok(res.errorCount >= 5);

  // Committing the same file writes nothing either: any blocking problem stops the whole upload.
  const refused = await setup.importRecipes({ csv, commit: true, submit: true }, formulator);
  assert.equal(refused.committed, false);
  const after = await db.select().from(formulaIngredients).where(eq(formulaIngredients.formulaVersionId, blend.latestVersion!.formulaVersionId));
  assert.equal(after.length, before.length);
});

test('import commit: sealed AS THE UPLOADER into the shell\'s draft, stages recorded, submitted; then the uploader cannot approve, the approver can', async () => {
  const shells = (await setup.ensureShells({ products: [product('UPA', 'blend'), product('UPB', 'blend')] }, ruh)).results;
  const [a, b] = shells as [typeof shells[0], typeof shells[0]];
  const tsv = [
    'product_code\tmaterial_code\tpercentage\tstage\tsequence',
    `${a.productCode}\t${M.linalool.materialCode}\t12,5\tTop\t1`,
    `\t${M.hedione.materialCode}\t87,5\tHeart\t2`,
    `${b.formulaCode}\t${M.iso.materialCode}\t100\t\t`,
  ].join('\n').replace(`${b.formulaCode}\t`, `${b.productCode}\t`);
  const res = await setup.importRecipes({ csv: tsv, commit: true, submit: true }, formulator);
  assert.equal(res.errorCount, 0, JSON.stringify(res.rows.filter((r) => r.error)));
  assert.equal(res.committed, true);
  assert.equal(res.warningCount, 0);

  const va = (await versionsOf(a.formulaId!))[0]!;
  assert.equal(va.status, 'REVIEW');
  assert.equal(va.createdBy, ruh.userId, 'the version is still Ruh\'s shell');
  assert.equal(va.submittedBy, formulator.userId);
  const sealedA = await db.select().from(formulaIngredients).where(eq(formulaIngredients.formulaVersionId, va.formulaVersionId));
  assert.deepEqual(sealedA.map((s) => s.createdBy), [formulator.userId, formulator.userId], 'sealed as the uploading user');
  assert.deepEqual(sealedA.map((s) => s.sequenceNo).sort(), [1, 2]);
  const stages = await db.select().from(formulaStageMaster).where(eq(formulaStageMaster.formulaVersionId, va.formulaVersionId));
  assert.deepEqual(stages.map((s) => s.stageName).sort(), ['Heart', 'Top']);

  // The uploader holds (here) the approval permission too — still refused: they sealed the recipe.
  const uploaderWithApproval = { ...formulator, permissions: ['formula:formula_approval:write'] };
  await assert.rejects(() => approvals.approveVersion(va.formulaVersionId, {}, uploaderWithApproval), /you sealed ingredients on this formula version/);
  const refusal = await db.select().from(auditEvents)
    .where(and(eq(auditEvents.entityId, va.formulaVersionId), eq(auditEvents.action, 'formula.version.approve.self_refused')));
  assert.ok(refusal.some((r) => r.actorId === formulator.userId));

  // The review queue tells each person what they may approve.
  const forUploader = (await setup.reviewQueue(formulator)).find((q) => q.formulaVersionId === va.formulaVersionId)!;
  assert.equal(forUploader.blockedReason, 'You sealed this recipe.');
  assert.deepEqual(forUploader.sealedBy, [formulator.userId]);
  assert.equal(forUploader.productCode, a.productCode);
  assert.match(forUploader.note ?? '', /2 ingredient\(s\) sealed from a recipe upload, total 100%/);
  const forRuh = (await setup.reviewQueue(ruh)).find((q) => q.formulaVersionId === va.formulaVersionId)!;
  assert.equal(forRuh.blockedReason, 'You drafted this version.');
  const forApprover = (await setup.reviewQueue(approver)).find((q) => q.formulaVersionId === va.formulaVersionId)!;
  assert.equal(forApprover.blockedReason, null);

  const recipeA = await approvals.approveVersion(va.formulaVersionId, {}, approver)
    .then(() => vault.decryptVersion(va.formulaVersionId, { actorId: approver.userId, action: 'formula.test.read', entityType: 'formula_version', entityId: va.formulaVersionId }));
  assert.deepEqual(recipeA, [
    { materialId: M.linalool.materialId, percentage: 12.5, sequenceNo: 1 },
    { materialId: M.hedione.materialId, percentage: 87.5, sequenceNo: 2 },
  ]);

  // A second upload into an already-sealed recipe is refused (sealed lines cannot be replaced) —
  // here B is in review, so the message says so.
  const again = await setup.importRecipes({ csv: `product_code,material_code,percentage\n${b.productCode},${M.iso.materialCode},100`, commit: false, submit: true }, formulator);
  assert.ok(again.recipes[0]!.errors.some((e) => /waiting for a decision/.test(e)));
});

test('import: an approved formula gets a NEW version authored by the uploader (never a change to the approved one)', async () => {
  const sc = (await setup.ensureShells({ products: [product('NEWV', 'single_chemical', M.single.materialId)] }, ruh)).results[0]!;
  await approvals.approveVersion(sc.latestVersion!.formulaVersionId, {}, approver);
  const res = await setup.importRecipes({ csv: `formula_code,material_code,percentage\n${sc.formulaCode},${M.single.materialCode},99.5\n${sc.formulaCode},${M.iso.materialCode},0.5`, commit: true, submit: true }, formulator);
  assert.equal(res.committed, true, JSON.stringify(res));
  assert.deepEqual(res.recipes[0]!.version.versionNumber, 2);
  const versions = (await versionsOf(sc.formulaId!)).sort((x, y) => (x.versionNumber ?? 0) - (y.versionNumber ?? 0));
  assert.deepEqual(versions.map((v) => [v.versionNumber, v.status, v.createdBy]), [
    [1, 'APPROVED', ruh.userId],
    [2, 'REVIEW', formulator.userId],
  ]);
});

/* ── one-person bulk approval ───────────────────────────────────────────────────────────── */

test('approveMany: one session approves many — each its own transaction and audit row with the human actor; a refused row does not stop the rest', async () => {
  const shells = (await setup.ensureShells({
    products: [product('BULK1', 'single_chemical', M.single.materialId), product('BULK2', 'single_chemical', M.single.materialId), product('BULK3', 'blend')],
  }, ruh)).results;
  const ids = shells.map((s) => s.latestVersion!.formulaVersionId);
  const mine = (await formulas.createFormula({ formulaCode: `MINE-${run}-${randomUUID().slice(0, 4)}`, formulaName: 'approver draft' }, approver));
  const ownVersion = await formulas.createVersion({ formulaId: mine.formulaId, versionNumber: 1 }, approver);

  // The approver's own draft, sealed and submitted by them: refused by SoD inside the batch.
  await formulas.addIngredients(ownVersion.formulaVersionId, { ingredients: [{ materialId: M.iso.materialId, percentage: 100 }] }, approver);
  await approvals.submitForReview(ownVersion.formulaVersionId, {}, approver);

  const results = await setup.approveMany([...ids, ownVersion.formulaVersionId, randomUUID()], 'bulk ok', approver);
  assert.deepEqual(results.map((r) => r.approved), [true, true, false, false, false]);
  assert.match(results[2]!.error!, /Not submitted for review \(status DRAFT\)/, 'an empty blend shell is never bulk-approved');
  assert.match(results[3]!.error!, /segregation of duties/);
  assert.match(results[4]!.error!, /No such formula version/);
  const approvedIds = ids.slice(0, 2);
  const rows = await db.select().from(auditEvents).where(and(inArray(auditEvents.entityId, approvedIds), eq(auditEvents.action, 'formula.version.approved')));
  assert.equal(rows.length, 2, 'one audit row per approved version');
  assert.ok(rows.every((r) => r.actorId === approver.userId));
  const approvalsRows = await db.select().from(formulaApproval).where(inArray(formulaApproval.formulaVersionId, ids));
  assert.equal(approvalsRows.length, 2);
  assert.ok(approvalsRows.every((r) => r.approverUserId === approver.userId && r.remarks === 'bulk ok'));
  const chain = await vault.verifyAuditChain();
  assert.equal(chain.ok, true, chain.reason ?? '');
});

/* ── routes ─────────────────────────────────────────────────────────────────────────────── */

const reflector = new Reflector();
const guard = new PermissionsGuard(reflector);
const fresh = new FreshAuthGuard(reflector);
function ctx(method: string, user: unknown) {
  const handler = (FormulaSetupController.prototype as unknown as Record<string, unknown>)[method];
  return {
    getHandler: () => handler,
    getClass: () => FormulaSetupController,
    switchToHttp: () => ({ getRequest: () => ({ user, url: `/${method}` }) }),
  } as never;
}
const grant = (code: string) => RA_PERMISSIONS.filter((p) => ROLES.find((r) => r.code === code)!.select(p));
const forbidden = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof DomainError && (e as DomainError).status === 403);

test('routes: formulator drafts and uploads but cannot approve; vault_approver approves but cannot draft or upload; owner does neither', () => {
  const f = principal({ roles: ['formulator'], permissions: grant('formulator') });
  const a = principal({ roles: ['vault_approver'], permissions: grant('vault_approver') });
  const o = principal({ roles: ['owner'], permissions: grant('owner') });
  assert.equal(guard.canActivate(ctx('shells', f)), true);
  assert.equal(guard.canActivate(ctx('importRecipes', f)), true);
  forbidden(() => guard.canActivate(ctx('approveBatch', f)));
  assert.equal(guard.canActivate(ctx('approveBatch', a)), true);
  assert.equal(guard.canActivate(ctx('reviewQueue', a)), true);
  forbidden(() => guard.canActivate(ctx('shells', a)));
  forbidden(() => guard.canActivate(ctx('importRecipes', a)));
  for (const m of ['shells', 'importRecipes', 'approveBatch']) forbidden(() => guard.canActivate(ctx(m, o)));
  // Ruh's token carries exactly the three drafting permissions: it can draft, nothing else here.
  assert.equal(guard.canActivate(ctx('shells', ruh)), true);
  forbidden(() => guard.canActivate(ctx('importRecipes', principal({ permissions: ['formula:formula_master:write'] }))));
  forbidden(() => guard.canActivate(ctx('approveBatch', ruh)));
});

test('routes: the batch approval demands a fresh sign-in, checked once per request (the same 300 s @FreshAuth window as approve)', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(fresh.canActivate(ctx('approveBatch', principal({ authTime: now - 60 }))), true);
  forbidden(() => fresh.canActivate(ctx('approveBatch', principal({ authTime: now - 301 }))));
  // The import and the shells are drafting, not decisions: no step-up.
  assert.equal(fresh.canActivate(ctx('importRecipes', principal({ authTime: now - 3600 }))), true);
});
