/**
 * FormulaSetupService — the Vault box's half of getting every factory product a formula (lane
 * vaultsetup; owner decisions 2026-10-05: products are MOSTLY BLENDED IN-HOUSE; "Ruh drafts, one
 * person approves"; formula content never leaves the Vault and never passes through an AI model).
 *
 *   ensureShells   one formula SHELL per product (formula_master + DRAFT v1 + formula_product_link,
 *                  one transaction), authored by the caller — on the factory's "Draft formula
 *                  shells" click that caller is the Ruh service principal, whose token the main box
 *                  mints for this one call (cluster-org ServicePrincipalService). Idempotent: a
 *                  product that already has a shell gets that shell back, never a second one.
 *                    single_chemical  sealed at once: [{ the product's own material, 100 %, seq 1 }],
 *                                     then submitted for review — one approval away from production.
 *                    blend            left an empty DRAFT: "recipe needed".
 *   recipes        every shell with its state (recipe needed / draft / in review / approved) — the
 *                  Vault console's "Recipes needed" screen.
 *   importRecipes  the recipe upload: a pasted or uploaded CSV/TSV (setup/recipe-csv.ts), parsed
 *                  HERE, deterministically; each line matched to a formula (product code or formula
 *                  code) and a material (exact code or name — no guessing); a preview with every
 *                  unmatched name, every bad number and each recipe's total (≠ 100 % warns, ≤ 0
 *                  blocks); then, on commit, every recipe sealed AS THE UPLOADING USER (who needs
 *                  formula:formula_ingredients:write — a formulator) in one transaction, and
 *                  submitted for review.
 *   reviewQueue    every version waiting for a decision, with who wrote it and who sealed its
 *                  recipe — and, for the caller, whether they may approve it.
 *   approveMany    the one-person bulk approval: ONE fresh sign-in (the route's @FreshAuth), then
 *                  each version through the unchanged ApprovalsService.approveVersion — its own
 *                  transaction, its own audit row with the real human actor, its own SoD check.
 *
 * AUTHOR ≠ APPROVER IN EVERY PATH. The shell's version is authored by Ruh; the recipe is sealed by
 * the uploading formulator; ApprovalsService refuses the version's author AND anyone who sealed an
 * ingredient on it. A service principal can never approve at all (it may hold `formulator` only —
 * SecurityService). So the approving person is always someone who neither drafted nor supplied
 * the recipe. There is deliberately NO mode where an approver's own upload is attributed to Ruh:
 * that would keep author ≠ approver true on paper while one person both wrote and approved.
 *
 * Nothing here logs recipe content; the import's preview returns the uploader's own lines to the
 * Vault console only (this route exists only on the Vault box).
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import {
  MASTERDATA_LOOKUP,
  materialMatchKey,
  type MasterdataLookup,
  type MaterialRef,
} from '@ra/cluster-masterdata';
import { FORMULA_DB, formulaSchema, type FormulaDb } from '../formula.tokens.js';
import { KMS_PORT, type KmsPort } from '../crypto/kms.port.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import type { FormulaShellsBody, RecipeImportBody, ShellKind } from '../formula.dtos.js';
import { isHundred, parseRecipeFile, totalPercent, type RecipeLine } from './recipe-csv.js';

const { formulaMaster, formulaProductLink, formulaEventHist } = formulaSchema;

/** A shell's state, as the Vault console and the factory's setup screen show it. */
export type ShellState = 'recipe_needed' | 'draft' | 'in_review' | 'approved' | 'archived';

export interface ShellView {
  productId: string;
  productCode: string;
  productName: string | null;
  kind: ShellKind;
  formulaId: string;
  formulaCode: string | null;
  /** The formula's latest version (highest number). */
  latestVersion: { formulaVersionId: string; versionNumber: number | null; status: string | null; sealedCount: number } | null;
  /** The formula's current APPROVED/LOCKED version, if any. */
  approvedVersionNumber: number | null;
  state: ShellState;
}

export interface ShellResult extends Partial<ShellView> {
  productId: string;
  productCode: string;
  outcome: 'created' | 'existing' | 'error';
  error?: string;
}

/** The formula code a product's shell gets: F-<product code>, within formula_code's 50 chars. */
export function shellFormulaCode(productCode: string): string {
  return `F-${productCode.trim()}`.slice(0, 50);
}

export interface ImportRow {
  line: number;
  target: string;
  formulaId: string | null;
  formulaCode: string | null;
  productCode: string | null;
  material: string;
  materialId: string | null;
  materialCode: string | null;
  materialName: string | null;
  percentage: number | null;
  stage: string | null;
  sequenceNo: number | null;
  error: string | null;
  /** For an unmatched material: up to three catalogue materials containing the typed text. */
  suggestions?: Array<{ materialCode: string | null; materialName: string | null }>;
}

export interface ImportRecipe {
  formulaId: string;
  formulaCode: string | null;
  productCode: string | null;
  lineCount: number;
  /** Sum of the recipe's percentages (exact at 6 decimals). */
  total: number;
  /** The version the recipe is (or would be) sealed into, and whether the upload creates it. */
  version: { versionNumber: number; create: boolean; formulaVersionId: string | null };
  warnings: string[];
  errors: string[];
}

export interface ImportResult {
  committed: boolean;
  fileErrors: string[];
  rows: ImportRow[];
  recipes: ImportRecipe[];
  errorCount: number;
  warningCount: number;
}

export interface ReviewItem {
  formulaVersionId: string;
  formulaId: string;
  formulaCode: string | null;
  formulaName: string | null;
  productCode: string | null;
  kind: ShellKind | null;
  versionNumber: number | null;
  status: string | null;
  authorId: string | null;
  /** Everyone who sealed an ingredient (or stage ingredient) on this version. */
  sealedBy: string[];
  sealedCount: number;
  submittedBy: string | null;
  submittedDt: string | null;
  /** The latest seal note (e.g. "3 ingredient(s) sealed from a recipe upload, total 100%"). */
  note: string | null;
  /** Why the CALLER may not approve this one (null = they may). The server re-checks anyway. */
  blockedReason: string | null;
}

export interface BatchApprovalResult {
  formulaVersionId: string;
  approved: boolean;
  formulaId?: string | null;
  error?: string;
}

const PRE_DECISION = new Set(['VERSIONED', 'REVIEW']);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function pgCode(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  return {
    code: e?.code ?? e?.cause?.code,
    constraint: e?.constraint_name ?? e?.cause?.constraint_name,
  };
}

@Injectable()
export class FormulaSetupService {
  constructor(
    @Inject(FORMULA_DB) private readonly db: FormulaDb,
    @Inject(KMS_PORT) private readonly kms: KmsPort,
    private readonly vault: VaultService,
    private readonly formulas: FormulasService,
    private readonly approvals: ApprovalsService,
    @Inject(MASTERDATA_LOOKUP) private readonly masterdata: MasterdataLookup,
  ) {}

  /* ── shells ─────────────────────────────────────────────────────────────────────────── */

  async ensureShells(body: FormulaShellsBody, principal: AuthPrincipal): Promise<{ results: ShellResult[] }> {
    const results: ShellResult[] = [];
    for (const p of body.products) {
      try {
        results.push(await this.ensureShell(p, principal));
      } catch (err) {
        results.push({ productId: p.productId, productCode: p.productCode, outcome: 'error', error: (err as Error).message });
      }
    }
    return { results };
  }

  private async ensureShell(p: FormulaShellsBody['products'][number], principal: AuthPrincipal): Promise<ShellResult> {
    const existing = await this.viewsFor({ productIds: [p.productId] });
    if (existing[0]) return { ...existing[0], outcome: 'existing' };

    const materialId = p.kind === 'single_chemical' ? p.materialId ?? null : null;
    if (p.kind === 'single_chemical') {
      if (!materialId) throw new BadRequestException('A single-chemical product needs its own material to seal at 100 %.');
      const material = await this.masterdata.findMaterial(materialId);
      if (!material) throw new BadRequestException('The product\'s material is not in the material catalogue the Vault holds.');
    }

    const formulaCode = shellFormulaCode(p.productCode);
    const clash = await this.db
      .select({ formulaId: formulaMaster.formulaId })
      .from(formulaMaster)
      .where(sql`lower(${formulaMaster.formulaCode}) = lower(${formulaCode})`)
      .limit(1);
    if (clash[0]) {
      // A duplicate request can commit between the first look above and this one. That is the same shell,
      // not another formula using the code: answer with it, so a double click never reads as a failure.
      const raced = await this.viewsFor({ productIds: [p.productId] });
      if (raced[0]) return { ...raced[0], outcome: 'existing' };
      throw new BadRequestException(
        `Formula code ${formulaCode} is already used by another formula — link that formula to the product instead.`,
      );
    }

    const formulaId = uuidv7();
    const formulaVaultId = uuidv7();
    const { wrapped } = await this.kms.generateDek({ formulaId, vaultId: formulaVaultId });
    try {
      await this.db.transaction(async (tx) => {
        await this.formulas.createFormulaTx(
          tx,
          { formulaCode, formulaName: p.productName?.trim() || p.productCode },
          principal,
          { formulaId, formulaVaultId },
          wrapped,
        );
        const version = await this.formulas.createVersionTx(tx, { formulaId, versionNumber: 1 }, principal);
        await tx.insert(formulaProductLink).values({
          formulaId,
          productId: p.productId,
          productCode: p.productCode,
          productName: p.productName?.trim() || null,
          kind: p.kind,
          materialId,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        });
        if (p.kind === 'single_chemical' && materialId) {
          await this.formulas.sealIngredientsTx(
            tx,
            version.formulaVersionId,
            [{ materialId, percentage: 100, sequenceNo: 1 }],
            principal,
            { remarks: 'single chemical: 1 ingredient sealed at 100% (drafted from the factory catalogue)' },
          );
          await this.approvals.submitForReviewTx(
            tx,
            version.formulaVersionId,
            { remarks: 'single chemical drafted from the factory catalogue' },
            principal,
          );
        } else {
          await tx.insert(formulaEventHist).values({
            formulaEventHistId: uuidv7(),
            formulaId,
            formulaVersionId: version.formulaVersionId,
            eventType: 'RECIPE_NEEDED',
            eventDt: new Date(),
            performedBy: principal.userId,
            remarks: 'blend: shell drafted from the factory catalogue, recipe needed',
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          });
        }
        await this.vault.writeAudit(tx, {
          actorId: principal.userId,
          action: 'formula.shell.drafted',
          entityType: 'formula_master',
          entityId: formulaId,
          reason: `${p.kind} shell for product ${p.productCode}`,
        });
      });
    } catch (err) {
      const { code, constraint } = pgCode(err);
      if (code === '23505') {
        // A concurrent call drafted this product's shell first (its formula code or its product
        // link collided, after that call committed): answer with that one.
        const raced = await this.viewsFor({ productIds: [p.productId] });
        if (raced[0]) return { ...raced[0], outcome: 'existing' };
      }
      if (code === '23505' && constraint === 'formula_master_code_uq') {
        throw new BadRequestException(`Formula code ${formulaCode} is already used by another formula.`);
      }
      throw err;
    }
    const created = await this.viewsFor({ productIds: [p.productId] });
    return { ...(created[0] ?? {}), productId: p.productId, productCode: p.productCode, outcome: 'created' };
  }

  /* ── recipes (shell states) ─────────────────────────────────────────────────────────── */

  async recipes(): Promise<ShellView[]> {
    return this.viewsFor({});
  }

  /** Shell views, optionally narrowed to product ids or formula ids. Three set queries. */
  private async viewsFor(filter: { productIds?: string[]; formulaIds?: string[] }): Promise<ShellView[]> {
    const where = filter.productIds
      ? inArray(formulaProductLink.productId, filter.productIds)
      : filter.formulaIds
        ? inArray(formulaProductLink.formulaId, filter.formulaIds)
        : undefined;
    const links = await this.db
      .select({
        productId: formulaProductLink.productId,
        productCode: formulaProductLink.productCode,
        productName: formulaProductLink.productName,
        kind: formulaProductLink.kind,
        formulaId: formulaProductLink.formulaId,
        formulaCode: formulaMaster.formulaCode,
        currentVersionId: formulaMaster.currentVersionId,
      })
      .from(formulaProductLink)
      .innerJoin(formulaMaster, eq(formulaMaster.formulaId, formulaProductLink.formulaId))
      .where(where)
      .orderBy(formulaProductLink.productCode);
    if (links.length === 0) return [];
    const versions = await this.versionFacts(links.map((l) => l.formulaId));
    return links.map((l) => {
      const mine = versions.filter((v) => v.formula_id === l.formulaId);
      const latest = mine[0] ?? null;
      const current = mine.find((v) => v.formula_version_id === l.currentVersionId && (v.status === 'APPROVED' || v.status === 'LOCKED'));
      return {
        productId: l.productId,
        productCode: l.productCode,
        productName: l.productName,
        kind: l.kind as ShellKind,
        formulaId: l.formulaId,
        formulaCode: l.formulaCode,
        latestVersion: latest
          ? { formulaVersionId: latest.formula_version_id, versionNumber: latest.version_number, status: latest.status, sealedCount: latest.sealed }
          : null,
        approvedVersionNumber: current?.version_number ?? null,
        state: shellState(latest),
      };
    });
  }

  /** Every version of the given formulas, newest number first, with its sealed-ingredient count. */
  private async versionFacts(formulaIds: string[]) {
    if (formulaIds.length === 0) return [];
    return (await this.db.execute(sql`
      select v.formula_id::text as formula_id, v.formula_version_id::text as formula_version_id,
             v.version_number, v.status,
             (select count(*)::int from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id) as sealed
        from formula.formula_version v
       where v.formula_id in ${formulaIds}
       order by v.formula_id, v.version_number desc nulls last
    `)) as unknown as Array<{ formula_id: string; formula_version_id: string; version_number: number | null; status: string | null; sealed: number }>;
  }

  /* ── recipe import ──────────────────────────────────────────────────────────────────── */

  async importRecipes(body: RecipeImportBody, principal: AuthPrincipal): Promise<ImportResult> {
    const parsed = parseRecipeFile(body.csv);
    if (parsed.fileErrors.length > 0) {
      return { committed: false, fileErrors: parsed.fileErrors, rows: [], recipes: [], errorCount: parsed.fileErrors.length, warningCount: 0 };
    }

    const targets = await this.resolveTargets(parsed.lines);
    const materials = await this.resolveMaterials(parsed.lines);

    const rows: ImportRow[] = [];
    for (const l of parsed.lines) {
      const t = targets.get(targetKey(l));
      const m = materials.get(materialKeyOf(l));
      const error = l.errors[0] ?? t?.error ?? m?.error ?? null;
      rows.push({
        line: l.line,
        target: l.target,
        formulaId: t?.formulaId ?? null,
        formulaCode: t?.formulaCode ?? null,
        productCode: t?.productCode ?? null,
        material: l.material,
        materialId: m?.ref?.materialId ?? null,
        materialCode: m?.ref?.materialCode ?? null,
        materialName: m?.ref?.materialName ?? null,
        percentage: l.percentage,
        stage: l.stage,
        sequenceNo: l.sequenceNo,
        error: l.errors.length > 1 ? l.errors.join('; ') : error,
        ...(m?.suggestions ? { suggestions: m.suggestions } : {}),
      });
    }

    // Per recipe (formula): duplicates, total, and which version it lands in.
    const byFormula = new Map<string, ImportRow[]>();
    for (const r of rows) {
      if (!r.formulaId) continue;
      const list = byFormula.get(r.formulaId) ?? [];
      list.push(r);
      byFormula.set(r.formulaId, list);
    }
    const facts = await this.versionFacts([...byFormula.keys()]);
    const stagesByVersion = await this.stageCounts(facts.map((f) => f.formula_version_id));
    const recipes: ImportRecipe[] = [];
    for (const [formulaId, list] of byFormula) {
      const warnings: string[] = [];
      const errors: string[] = [];
      const seen = new Map<string, number>();
      for (const r of list) {
        if (!r.materialId) continue;
        const k = `${r.materialId}|${(r.stage ?? '').toLowerCase()}`;
        const first = seen.get(k);
        if (first !== undefined) errors.push(`line ${r.line} repeats the material on line ${first}${r.stage ? ` (stage ${r.stage})` : ''}`);
        else seen.set(k, r.line);
      }
      const total = totalPercent(list.map((r) => r.percentage ?? 0));
      if (!isHundred(total)) warnings.push(`the percentages add up to ${total}%, not 100%`);

      const mine = facts.filter((f) => f.formula_id === formulaId);
      const latest = mine[0] ?? null;
      const nextNumber = (mine.reduce((m, f) => Math.max(m, f.version_number ?? 0), 0) || 0) + 1;
      let version: ImportRecipe['version'];
      if (latest && latest.status === 'DRAFT') {
        const staged = stagesByVersion.get(latest.formula_version_id) ?? 0;
        if (latest.sealed > 0 || staged > 0) {
          errors.push(`v${latest.version_number} already has sealed ingredients — sealed lines cannot be replaced; create a new version first`);
        }
        version = { versionNumber: latest.version_number ?? 1, create: false, formulaVersionId: latest.formula_version_id };
      } else if (latest && PRE_DECISION.has(latest.status ?? '')) {
        errors.push(`v${latest.version_number} is waiting for a decision — reject it (or wait for it to be approved) before uploading a new recipe`);
        version = { versionNumber: latest.version_number ?? 1, create: false, formulaVersionId: latest.formula_version_id };
      } else {
        version = { versionNumber: nextNumber, create: true, formulaVersionId: null };
      }
      recipes.push({
        formulaId,
        formulaCode: list[0]?.formulaCode ?? null,
        productCode: list[0]?.productCode ?? null,
        lineCount: list.length,
        total,
        version,
        warnings,
        errors,
      });
    }
    recipes.sort((a, b) => String(a.productCode ?? a.formulaCode).localeCompare(String(b.productCode ?? b.formulaCode)));

    const rowErrors = rows.filter((r) => r.error).length;
    const errorCount = rowErrors + recipes.reduce((n, r) => n + r.errors.length, 0);
    const warningCount = recipes.reduce((n, r) => n + r.warnings.length, 0);
    if (!body.commit || errorCount > 0) {
      return { committed: false, fileErrors: [], rows, recipes, errorCount, warningCount };
    }

    await this.db.transaction(async (tx) => {
      for (const recipe of recipes) {
        const lines = byFormula.get(recipe.formulaId) ?? [];
        let versionId = recipe.version.formulaVersionId;
        if (recipe.version.create || !versionId) {
          const created = await this.formulas.createVersionTx(tx, { formulaId: recipe.formulaId, versionNumber: recipe.version.versionNumber }, principal);
          versionId = created.formulaVersionId;
          recipe.version = { ...recipe.version, formulaVersionId: versionId };
        }
        await this.formulas.sealIngredientsTx(
          tx,
          versionId,
          lines.map((r, i) => ({ materialId: r.materialId!, percentage: r.percentage!, sequenceNo: r.sequenceNo ?? i + 1 })),
          principal,
          { remarks: `${lines.length} ingredient(s) sealed from a recipe upload, total ${recipe.total}%` },
        );
        // Lines naming a stage are also sealed into that stage (stage order = first appearance).
        const stageNames: string[] = [];
        for (const r of lines) if (r.stage && !stageNames.some((s) => s.toLowerCase() === r.stage!.toLowerCase())) stageNames.push(r.stage);
        for (const [i, name] of stageNames.entries()) {
          const stage = await this.formulas.createStageTx(tx, { formulaVersionId: versionId, stageName: name, sequenceNo: i + 1 }, principal);
          const inStage = lines.filter((r) => r.stage && r.stage.toLowerCase() === name.toLowerCase());
          await this.formulas.sealStageIngredientsTx(
            tx,
            stage.formulaStageId,
            inStage.map((r, j) => ({ materialId: r.materialId!, percentage: r.percentage!, sequenceNo: r.sequenceNo ?? j + 1 })),
            principal,
          );
        }
        if (body.submit) {
          await this.approvals.submitForReviewTx(tx, versionId, { remarks: 'submitted with the recipe upload' }, principal);
        }
      }
    });
    return { committed: true, fileErrors: [], rows, recipes, errorCount: 0, warningCount };
  }

  private async stageCounts(versionIds: string[]): Promise<Map<string, number>> {
    if (versionIds.length === 0) return new Map();
    const rows = (await this.db.execute(sql`
      select s.formula_version_id::text as v, count(si.*)::int as n
        from formula.formula_stage_master s
        join formula.formula_stage_ingredients si on si.formula_stage_id = s.formula_stage_id
       where s.formula_version_id in ${versionIds}
       group by s.formula_version_id
    `)) as unknown as Array<{ v: string; n: number }>;
    return new Map(rows.map((r) => [r.v, r.n]));
  }

  /** Each distinct (kind, text) target → its formula, or why not. Exact, case-insensitive. */
  private async resolveTargets(lines: RecipeLine[]) {
    const out = new Map<string, { formulaId?: string; formulaCode?: string | null; productCode?: string | null; error?: string }>();
    const productCodes = [...new Set(lines.filter((l) => l.target && l.targetKind === 'product').map((l) => l.target.toLowerCase()))];
    const formulaCodes = [...new Set(lines.filter((l) => l.target && l.targetKind === 'formula').map((l) => l.target.toLowerCase()))];

    const byProduct = productCodes.length
      ? await this.db
          .select({ productCode: formulaProductLink.productCode, formulaId: formulaProductLink.formulaId, formulaCode: formulaMaster.formulaCode })
          .from(formulaProductLink)
          .innerJoin(formulaMaster, eq(formulaMaster.formulaId, formulaProductLink.formulaId))
          .where(sql`lower(${formulaProductLink.productCode}) in ${productCodes}`)
      : [];
    const byFormula = formulaCodes.length
      ? await this.db
          .select({ formulaId: formulaMaster.formulaId, formulaCode: formulaMaster.formulaCode, productCode: formulaProductLink.productCode })
          .from(formulaMaster)
          .leftJoin(formulaProductLink, eq(formulaProductLink.formulaId, formulaMaster.formulaId))
          .where(sql`lower(${formulaMaster.formulaCode}) in ${formulaCodes}`)
      : [];

    for (const code of productCodes) {
      const hits = byProduct.filter((r) => r.productCode.toLowerCase() === code);
      out.set(`product|${code}`, hits.length === 1
        ? { formulaId: hits[0]!.formulaId, formulaCode: hits[0]!.formulaCode, productCode: hits[0]!.productCode }
        : hits.length === 0
          ? { error: `no formula shell for product "${code}" — draft the shells from the factory first, or use a formula_code column` }
          : { error: `more than one formula is linked to product "${code}"` });
    }
    for (const code of formulaCodes) {
      const hits = byFormula.filter((r) => (r.formulaCode ?? '').toLowerCase() === code);
      out.set(`formula|${code}`, hits.length === 1
        ? { formulaId: hits[0]!.formulaId, formulaCode: hits[0]!.formulaCode, productCode: hits[0]!.productCode ?? null }
        : hits.length === 0
          ? { error: `no formula with code "${code}"` }
          : { error: `more than one formula has code "${code}"` });
    }
    return out;
  }

  /** Each distinct (kind, text) material → exactly one catalogue material, or why not. */
  private async resolveMaterials(lines: RecipeLine[]) {
    const out = new Map<string, { ref?: MaterialRef; error?: string; suggestions?: ImportRow['suggestions'] }>();
    const keys = [...new Set(lines.filter((l) => l.material).map((l) => materialMatchKey(l.material)))];
    const matches = keys.length ? await this.masterdata.matchMaterials(keys) : [];
    const byCode = new Map<string, MaterialRef[]>();
    const byName = new Map<string, MaterialRef[]>();
    for (const m of matches) {
      const c = materialMatchKey(m.materialCode);
      const n = materialMatchKey(m.materialName);
      if (c) byCode.set(c, [...(byCode.get(c) ?? []), m]);
      if (n) byName.set(n, [...(byName.get(n) ?? []), m]);
    }
    for (const l of lines) {
      if (!l.material) continue;
      const mk = materialKeyOf(l);
      if (out.has(mk)) continue;
      const key = materialMatchKey(l.material);
      const codeHits = l.materialKind === 'name' ? [] : byCode.get(key) ?? [];
      const nameHits = l.materialKind === 'code' ? [] : byName.get(key) ?? [];
      const hits = codeHits.length > 0 ? codeHits : nameHits;
      if (hits.length === 1) { out.set(mk, { ref: hits[0]! }); continue; }
      if (hits.length > 1) {
        out.set(mk, { error: `"${l.material}" matches ${hits.length} materials — use the material code` });
        continue;
      }
      let suggestions: ImportRow['suggestions'] = [];
      try {
        suggestions = (await this.masterdata.searchMaterials(l.material, 3)).map((s) => ({ materialCode: s.materialCode, materialName: s.materialName }));
      } catch {
        suggestions = [];
      }
      const what = l.materialKind === 'code' ? 'code' : l.materialKind === 'name' ? 'name' : 'code or name';
      out.set(mk, { error: `no material with ${what} "${l.material}"`, suggestions });
    }
    return out;
  }

  /* ── review + bulk approval ─────────────────────────────────────────────────────────── */

  async reviewQueue(principal: AuthPrincipal): Promise<ReviewItem[]> {
    const rows = (await this.db.execute(sql`
      select v.formula_version_id::text as formula_version_id, v.formula_id::text as formula_id, m.formula_code, m.formula_name,
             l.product_code, l.kind, v.version_number, v.status, v.created_by as author_id,
             v.submitted_by::text as submitted_by, v.submitted_dt,
             (select count(*)::int from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id) as sealed_count,
             (select coalesce(array_agg(distinct x.created_by), '{}') from (
                select i.created_by from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id
                union
                select si.created_by from formula.formula_stage_ingredients si
                  join formula.formula_stage_master s on s.formula_stage_id = si.formula_stage_id
                 where s.formula_version_id = v.formula_version_id) x where x.created_by is not null) as sealed_by,
             (select h.remarks from formula.formula_event_hist h
               where h.formula_version_id = v.formula_version_id and h.event_type = 'INGREDIENTS_SEALED'
               order by h.event_dt desc limit 1) as note
        from formula.formula_version v
        join formula.formula_master m on m.formula_id = v.formula_id
        left join formula.formula_product_link l on l.formula_id = v.formula_id
       where v.status in ('VERSIONED', 'REVIEW')
       order by v.submitted_dt asc nulls last, l.product_code nulls last, m.formula_code
       limit 500
    `)) as unknown as Array<{
      formula_version_id: string; formula_id: string; formula_code: string | null; formula_name: string | null;
      product_code: string | null; kind: string | null; version_number: number | null; status: string | null;
      author_id: string | null; submitted_by: string | null; submitted_dt: Date | string | null;
      sealed_count: number; sealed_by: string[] | null; note: string | null;
    }>;
    return rows.map((r) => {
      const sealedBy = r.sealed_by ?? [];
      const blockedReason = r.author_id === principal.userId
        ? 'You drafted this version.'
        : sealedBy.includes(principal.userId)
          ? 'You sealed this recipe.'
          : r.sealed_count === 0
            ? 'Nothing is sealed in this version yet.'
            : null;
      return {
        formulaVersionId: r.formula_version_id,
        formulaId: r.formula_id,
        formulaCode: r.formula_code,
        formulaName: r.formula_name,
        productCode: r.product_code,
        kind: (r.kind as ShellKind | null) ?? null,
        versionNumber: r.version_number,
        status: r.status,
        authorId: r.author_id,
        sealedBy,
        sealedCount: r.sealed_count,
        submittedBy: r.submitted_by,
        submittedDt: iso(r.submitted_dt),
        note: r.note,
        blockedReason,
      };
    });
  }

  /**
   * Approve each version in turn through the unchanged ApprovalsService.approveVersion — every
   * approval is its own transaction with its own FORMULA_APPROVAL row, event, outbox signal and
   * hash-chained audit row naming the real (human) caller, and every SoD rule applies per row. A
   * refusal or error on one row does not stop the others; each row reports its own outcome.
   */
  async approveMany(versionIds: string[], remarks: string | undefined, principal: AuthPrincipal): Promise<BatchApprovalResult[]> {
    const out: BatchApprovalResult[] = [];
    const ids = [...new Set(versionIds)];
    // The batch approves SUBMITTED recipes only (VERSIONED/REVIEW, with something sealed): never an
    // empty shell or an unsubmitted draft, which the single-version route leaves to a deliberate
    // one-off decision. approveVersion re-checks status under its row lock.
    const facts = ids.length
      ? ((await this.db.execute(sql`
          select v.formula_version_id::text as id, v.status,
                 (select count(*)::int from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id) as sealed
            from formula.formula_version v where v.formula_version_id in ${ids}
        `)) as unknown as Array<{ id: string; status: string | null; sealed: number }>)
      : [];
    const factOf = new Map(facts.map((f) => [f.id, f]));
    for (const id of ids) {
      const f = factOf.get(id);
      if (!f) { out.push({ formulaVersionId: id, approved: false, error: 'No such formula version.' }); continue; }
      if (!PRE_DECISION.has(f.status ?? '')) {
        out.push({ formulaVersionId: id, approved: false, error: `Not submitted for review (status ${f.status}).` });
        continue;
      }
      if (f.sealed === 0) { out.push({ formulaVersionId: id, approved: false, error: 'Nothing is sealed in this version.' }); continue; }
      try {
        const res = await this.approvals.approveVersion(id, { remarks }, principal);
        out.push({ formulaVersionId: id, approved: true, formulaId: res.version.formulaId });
      } catch (err) {
        out.push({ formulaVersionId: id, approved: false, error: (err as Error).message });
      }
    }
    return out;
  }
}

function shellState(latest: { status: string | null; sealed: number } | null): ShellState {
  if (!latest) return 'recipe_needed';
  switch (latest.status) {
    case 'DRAFT':
      return latest.sealed > 0 ? 'draft' : 'recipe_needed';
    case 'REJECTED':
      return 'recipe_needed';
    case 'VERSIONED':
    case 'REVIEW':
      return 'in_review';
    case 'APPROVED':
    case 'LOCKED':
    case 'SUPERSEDED':
      return 'approved';
    default:
      return 'archived';
  }
}

const targetKey = (l: RecipeLine) => `${l.targetKind}|${l.target.toLowerCase()}`;
const materialKeyOf = (l: RecipeLine) => `${l.materialKind}|${materialMatchKey(l.material)}`;
