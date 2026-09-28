/**
 * ComplianceService — the Vault's raw-material compliance data and its IFRA / allergen
 * certificate calculation (owner ruling 2026-09-28, item 2). Runs in the Vault process only.
 *
 * DATA (entered/imported by the regulatory team; nothing is fabricated or seeded):
 *   - settings: allergen reporting threshold (%, default 0 = only an exact zero reads 'A'), the IFRA
 *     amendment in force, the regulated allergen list's reference;
 *   - the regulated allergen list (name + CAS) the allergen certificate reports against;
 *   - per raw material: allergen composition (CAS, % natural, % synthetic) and IFRA restrictions
 *     (category, RESTRICTED/PROHIBITED/SPECIFICATION, max % in product, amendment), each with an
 *     explicit "this material's data is complete" declaration (compliance-calc.ts says why).
 *   CSV imports are two-step: `importCsv(kind, csv, commit=false)` returns a per-row preview with
 *   every error; `commit=true` applies it only when there is none (all or nothing).
 *
 * CALCULATION (compliance-calc.ts): on a formula version's approval (ApprovalsController), on any
 * raw-material data / settings change (every formula), or on request. Decrypts the formula's
 * current APPROVED/LOCKED version through VaultService.decryptVersion — which writes the mandatory
 * hash-chained audit row (`formula.compliance.calculate`) — and stores ONLY the certificate numbers
 * in formula.compliance_certificate with an opaque, KEK-keyed `formulaVersionRef`. An identical
 * result for the same version is not stored twice, so the main box emits nothing new for a
 * recalculation that changed nothing. Missing data → no certificate; formula.compliance_calc_status
 * records the outcome and a COUNT of materials lacking data. The list of those materials is
 * computed on demand (decrypt again, audited) and shown only to Vault-authorised users — storing
 * it would put formula composition in plaintext at rest.
 */
import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { MASTERDATA_LOOKUP, type MasterdataLookup, type MaterialRef } from '@ra/cluster-masterdata';
import { FORMULA_DB, formulaSchema, type FormulaDb } from '../formula.tokens.js';
import { KMS_PORT, type KmsPort } from '../crypto/kms.port.js';
import { VaultService } from '../vault.service.js';
import {
  IFRA_CATEGORIES,
  IFRA_RESTRICTION_TYPES,
  calculateAllergens,
  calculateIfra,
  type AllergenReference,
  type CalcResult,
  type FormulaLine,
  type IfraRestrictionType,
  type MaterialComplianceData,
} from './compliance-calc.js';
import { MAX_IMPORT_ROWS, parseCsv } from './csv.js';

const {
  formulaMaster,
  formulaVersion,
  rmComplianceProfile,
  rmAllergenComposition,
  rmIfraRestriction,
  complianceAllergenRef,
  complianceSetting,
  complianceCertificate,
  complianceCalcStatus,
} = formulaSchema;

export const SETTING_KEYS = {
  threshold: 'allergen_reporting_threshold_pct',
  ifraAmendment: 'ifra_amendment',
  allergenListRef: 'allergen_list_ref',
} as const;

export type CertificateKindName = 'ifra' | 'allergen';
export type ImportKind = 'allergen' | 'ifra' | 'allergen_ref';

export interface ComplianceSettings {
  reportingThresholdPct: number;
  ifraAmendment: string | null;
  allergenListRef: string | null;
}

export interface MaterialDataInput {
  allergenComplete: boolean;
  ifraComplete: boolean;
  ifraAmendment?: string | null;
  sourceRef?: string | null;
  allergens: { cas: string; naturalPct: number; syntheticPct: number }[];
  ifra: { category: string; restrictionType: IfraRestrictionType; maxPct: number | null; amendment: string }[];
}

export interface ImportRowResult {
  line: number;
  materialCode?: string;
  materialName?: string | null;
  summary: string;
  error?: string;
}

export interface ImportResult {
  kind: ImportKind;
  committed: boolean;
  rows: ImportRowResult[];
  errorCount: number;
  materialCount: number;
}

/** One certificate as the main box pulls it (internal channel only). */
export interface InternalCertificate {
  seq: number;
  certificateId: string;
  formulaId: string;
  formulaVersionRef: string;
  kind: CertificateKindName;
  amendment: string | null;
  values: unknown;
  calculatedAt: string;
}

export interface FormulaCalcOutcome {
  formulaId: string;
  formulaVersionId: string | null;
  results: { kind: CertificateKindName; outcome: 'CERTIFIED' | 'UNCHANGED' | 'MISSING_DATA' | 'NOT_CONFIGURED' | 'NO_APPROVED_VERSION'; missingCount: number }[];
}

const toNum = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);
  /** Recalculate every formula after a data/settings change. A seam for tests, which drive the
   *  calculation of their own formulas explicitly instead of every formula in a shared database. */
  autoRecalculate = true;

  constructor(
    @Inject(FORMULA_DB) private readonly db: FormulaDb,
    @Inject(KMS_PORT) private readonly kms: KmsPort,
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(MASTERDATA_LOOKUP) private readonly masterdata: MasterdataLookup,
  ) {}

  /* ── settings ────────────────────────────────────────────────────────────────────────── */

  async settings(): Promise<ComplianceSettings> {
    const rows = await this.db.select().from(complianceSetting);
    const get = (k: string) => rows.find((r) => r.settingKey === k)?.settingValue ?? null;
    const threshold = Number(get(SETTING_KEYS.threshold) ?? '0');
    return {
      reportingThresholdPct: Number.isFinite(threshold) && threshold >= 0 ? threshold : 0,
      ifraAmendment: get(SETTING_KEYS.ifraAmendment),
      allergenListRef: get(SETTING_KEYS.allergenListRef),
    };
  }

  async updateSettings(input: Partial<ComplianceSettings>, principal: AuthPrincipal): Promise<ComplianceSettings> {
    const set = async (key: string, value: string | null) => {
      await this.db.insert(complianceSetting).values({ settingKey: key, settingValue: value, updatedBy: principal.userId })
        .onConflictDoUpdate({ target: complianceSetting.settingKey, set: { settingValue: value, updatedBy: principal.userId, updatedDt: new Date() } });
    };
    if (input.reportingThresholdPct !== undefined) {
      if (!(input.reportingThresholdPct >= 0 && input.reportingThresholdPct <= 100)) throw new BadRequestException('reporting threshold must be 0..100 %');
      await set(SETTING_KEYS.threshold, String(input.reportingThresholdPct));
    }
    if (input.ifraAmendment !== undefined) await set(SETTING_KEYS.ifraAmendment, input.ifraAmendment?.trim() || null);
    if (input.allergenListRef !== undefined) await set(SETTING_KEYS.allergenListRef, input.allergenListRef?.trim() || null);
    await this.writeAudit(principal, 'formula.compliance.settings_changed', null);
    this.recalculateAllInBackground('settings_changed', principal.userId);
    return this.settings();
  }

  /* ── regulated allergen list ─────────────────────────────────────────────────────────── */

  async allergenReferences(): Promise<AllergenReference[]> {
    const rows = await this.db.select().from(complianceAllergenRef).orderBy(asc(complianceAllergenRef.sortOrder), asc(complianceAllergenRef.name));
    return rows.map((r) => ({ name: r.name, cas: r.cas }));
  }

  /* ── raw-material data ───────────────────────────────────────────────────────────────── */

  /** Every material with a compliance profile, with its name from the pushed catalogue. */
  async listMaterialProfiles() {
    const profiles = await this.db.select().from(rmComplianceProfile).orderBy(desc(rmComplianceProfile.updatedDt));
    const counts = new Map<string, { allergens: number; ifra: number }>();
    for (const r of await this.db.select({ materialId: rmAllergenComposition.materialId }).from(rmAllergenComposition)) {
      const c = counts.get(r.materialId) ?? { allergens: 0, ifra: 0 }; c.allergens++; counts.set(r.materialId, c);
    }
    for (const r of await this.db.select({ materialId: rmIfraRestriction.materialId }).from(rmIfraRestriction)) {
      const c = counts.get(r.materialId) ?? { allergens: 0, ifra: 0 }; c.ifra++; counts.set(r.materialId, c);
    }
    const out = [];
    for (const p of profiles) {
      const m = await this.material(p.materialId);
      out.push({
        materialId: p.materialId, materialCode: m?.materialCode ?? null, materialName: m?.materialName ?? null,
        allergenComplete: p.allergenComplete, ifraComplete: p.ifraComplete, ifraAmendment: p.ifraAmendment,
        allergenRows: counts.get(p.materialId)?.allergens ?? 0, ifraRows: counts.get(p.materialId)?.ifra ?? 0,
        sourceRef: p.sourceRef, updatedDt: p.updatedDt,
      });
    }
    return out;
  }

  async materialData(materialId: string) {
    const m = await this.material(materialId);
    const profile = (await this.db.select().from(rmComplianceProfile).where(eq(rmComplianceProfile.materialId, materialId)).limit(1))[0] ?? null;
    const allergens = await this.db.select().from(rmAllergenComposition).where(eq(rmAllergenComposition.materialId, materialId)).orderBy(asc(rmAllergenComposition.cas));
    const ifra = await this.db.select().from(rmIfraRestriction).where(eq(rmIfraRestriction.materialId, materialId)).orderBy(asc(rmIfraRestriction.category));
    return {
      materialId, materialCode: m?.materialCode ?? null, materialName: m?.materialName ?? null,
      allergenComplete: profile?.allergenComplete ?? false, ifraComplete: profile?.ifraComplete ?? false,
      ifraAmendment: profile?.ifraAmendment ?? null, sourceRef: profile?.sourceRef ?? null,
      allergens: allergens.map((a) => ({ cas: a.cas, naturalPct: toNum(a.naturalPct), syntheticPct: toNum(a.syntheticPct) })),
      ifra: ifra.map((r) => ({ category: r.category, restrictionType: r.restrictionType, maxPct: r.maxPct === null ? null : Number(r.maxPct), amendment: r.amendment })),
    };
  }

  /** Replace one material's compliance data (the edit form). Validated like an import row set. */
  async saveMaterialData(materialId: string, input: MaterialDataInput, principal: AuthPrincipal) {
    if (!(await this.material(materialId))) throw new NotFoundException(`material not in the Vault's catalogue: ${materialId}`);
    const refs = new Set((await this.allergenReferences()).map((r) => r.cas));
    const errors = [
      ...validateAllergenRows(input.allergens, refs),
      ...validateIfraRows(input.ifra),
      ...(input.ifraComplete && !input.ifraAmendment?.trim() ? ['IFRA data marked complete needs the amendment it is for'] : []),
    ];
    if (errors.length > 0) throw new BadRequestException(errors.join('; '));
    await this.db.transaction(async (tx) => {
      await this.replaceAllergens(tx, materialId, input.allergens, input.allergenComplete, principal, input.sourceRef ?? null);
      await this.replaceIfra(tx, materialId, input.ifra, input.ifraComplete, input.ifraAmendment?.trim() || null, principal, input.sourceRef ?? null);
    });
    await this.writeAudit(principal, 'formula.compliance.material_data_changed', materialId);
    this.recalculateAllInBackground('material_data_changed', principal.userId);
    return this.materialData(materialId);
  }

  /* ── CSV import (preview, then commit) ───────────────────────────────────────────────── */

  async importCsv(kind: ImportKind, csv: string, commit: boolean, principal: AuthPrincipal): Promise<ImportResult> {
    const table = parseCsv(csv);
    if (table.rows.length > MAX_IMPORT_ROWS) throw new BadRequestException(`at most ${MAX_IMPORT_ROWS} rows per import`);
    const need: Record<ImportKind, string[]> = {
      allergen: ['material_code', 'cas', 'natural_pct', 'synthetic_pct'],
      ifra: ['material_code', 'amendment', 'category', 'restriction_type', 'max_pct'],
      allergen_ref: ['cas', 'name'],
    };
    const missingCols = need[kind].filter((c) => !table.header.includes(c));
    if (missingCols.length > 0) throw new BadRequestException(`CSV is missing column(s): ${missingCols.join(', ')}`);

    if (kind === 'allergen_ref') return this.importAllergenRefs(table.rows, commit, principal);

    const rows: ImportRowResult[] = [];
    const byMaterial = new Map<string, { ref: MaterialRef; allergens: MaterialDataInput['allergens']; ifra: MaterialDataInput['ifra']; declaredNone: boolean; noneAmendment?: string; lines: number[] }>();
    const refs = new Set((await this.allergenReferences()).map((r) => r.cas));
    for (const { line, cells } of table.rows) {
      const code = cells.material_code ?? '';
      const ref = code ? await this.materialByCode(code) : null;
      const row: ImportRowResult = { line, materialCode: code, materialName: ref?.materialName ?? null, summary: '' };
      rows.push(row);
      if (!ref) { row.error = code ? `material code "${code}" is not in the material master` : 'material_code is required'; continue; }
      const entry = byMaterial.get(ref.materialId) ?? { ref, allergens: [], ifra: [], declaredNone: false, lines: [] };
      byMaterial.set(ref.materialId, entry);
      entry.lines.push(line);
      if (kind === 'allergen') {
        const cas = cells.cas ?? '';
        if (!cas) {
          if ((cells.natural_pct && Number(cells.natural_pct) !== 0) || (cells.synthetic_pct && Number(cells.synthetic_pct) !== 0)) {
            row.error = 'a row with no CAS declares "no allergens" and must carry no percentages';
          } else { entry.declaredNone = true; row.summary = 'declares no regulated allergens'; }
          continue;
        }
        const a = { cas, naturalPct: pct(cells.natural_pct), syntheticPct: pct(cells.synthetic_pct) };
        const errs = validateAllergenRows([a], refs);
        if (errs.length > 0) { row.error = errs.join('; '); continue; }
        if (entry.allergens.some((x) => x.cas === cas)) { row.error = `duplicate CAS ${cas} for this material`; continue; }
        entry.allergens.push(a);
        row.summary = `${cas}: natural ${a.naturalPct} %, synthetic ${a.syntheticPct} %`;
      } else {
        const amendment = cells.amendment ?? '';
        const category = (cells.category ?? '').toUpperCase();
        if (!amendment) { row.error = 'amendment is required'; continue; }
        if (!category) {
          if (cells.restriction_type || cells.max_pct) row.error = 'a row with no category declares "not restricted" and must carry no restriction';
          else { entry.declaredNone = true; entry.noneAmendment = amendment; row.summary = `not restricted under amendment ${amendment}`; }
          continue;
        }
        const r = {
          category, restrictionType: (cells.restriction_type ?? '').toUpperCase() as IfraRestrictionType,
          maxPct: cells.max_pct === '' || cells.max_pct === undefined ? null : Number(cells.max_pct), amendment,
        };
        const errs = validateIfraRows([r]);
        if (errs.length > 0) { row.error = errs.join('; '); continue; }
        if (entry.ifra.some((x) => x.category === category)) { row.error = `duplicate category ${category} for this material`; continue; }
        entry.ifra.push(r);
        row.summary = `category ${category}: ${r.restrictionType}${r.maxPct !== null ? ` max ${r.maxPct} %` : ''} (amendment ${amendment})`;
      }
    }
    // Per-material consistency checks.
    for (const entry of byMaterial.values()) {
      const lineRows = rows.filter((r) => entry.lines.includes(r.line) && !r.error);
      const fail = (msg: string) => lineRows.forEach((r) => { r.error = msg; });
      if (kind === 'allergen' && entry.declaredNone && entry.allergens.length > 0) fail('this material both declares "no allergens" and lists allergens');
      if (kind === 'ifra') {
        const amendments = new Set([...entry.ifra.map((r) => r.amendment), ...(entry.noneAmendment ? [entry.noneAmendment] : [])]);
        if (amendments.size > 1) fail('all of a material\'s IFRA rows must be for one amendment');
        if (entry.declaredNone && entry.ifra.length > 0) fail('this material both declares "not restricted" and lists restrictions');
      }
    }
    const errorCount = rows.filter((r) => r.error).length;
    const result: ImportResult = { kind, committed: false, rows, errorCount, materialCount: byMaterial.size };
    if (!commit || errorCount > 0) return result;

    await this.db.transaction(async (tx) => {
      for (const [materialId, entry] of byMaterial) {
        if (kind === 'allergen') await this.replaceAllergens(tx, materialId, entry.allergens, true, principal, 'csv import');
        else {
          const amendment = entry.ifra[0]?.amendment ?? entry.noneAmendment ?? null;
          await this.replaceIfra(tx, materialId, entry.ifra, true, amendment, principal, 'csv import');
        }
      }
    });
    await this.writeAudit(principal, `formula.compliance.import_${kind}`, null);
    this.recalculateAllInBackground(`import_${kind}`, principal.userId);
    return { ...result, committed: true };
  }

  private async importAllergenRefs(input: { line: number; cells: Record<string, string> }[], commit: boolean, principal: AuthPrincipal): Promise<ImportResult> {
    const rows: ImportRowResult[] = [];
    const seen = new Set<string>();
    const valid: { cas: string; name: string; sortOrder: number }[] = [];
    for (const { line, cells } of input) {
      const cas = cells.cas ?? '', name = cells.name ?? '';
      const row: ImportRowResult = { line, summary: `${name} (${cas})` };
      rows.push(row);
      if (!isCas(cas)) { row.error = `"${cas}" is not a CAS number`; continue; }
      if (!name) { row.error = 'name is required'; continue; }
      if (seen.has(cas)) { row.error = `duplicate CAS ${cas}`; continue; }
      seen.add(cas);
      valid.push({ cas, name, sortOrder: cells.sort_order ? Number(cells.sort_order) || 0 : valid.length + 1 });
    }
    const errorCount = rows.filter((r) => r.error).length;
    const result: ImportResult = { kind: 'allergen_ref', committed: false, rows, errorCount, materialCount: 0 };
    if (!commit || errorCount > 0) return result;
    await this.db.transaction(async (tx) => {
      for (const v of valid) {
        await tx.insert(complianceAllergenRef)
          .values({ complianceAllergenRefId: uuidv7(), cas: v.cas, name: v.name, sortOrder: v.sortOrder, status: 'ACTIVE', createdBy: principal.userId, updatedBy: principal.userId })
          .onConflictDoUpdate({ target: complianceAllergenRef.cas, set: { name: v.name, sortOrder: v.sortOrder, updatedBy: principal.userId, updatedDt: new Date() } });
      }
    });
    await this.writeAudit(principal, 'formula.compliance.import_allergen_ref', null);
    this.recalculateAllInBackground('import_allergen_ref', principal.userId);
    return { ...result, committed: true };
  }

  /* ── calculation ─────────────────────────────────────────────────────────────────────── */

  /** Calculations run one at a time in this process, so two triggers (an approval and a data
   *  import landing together) can never both decide "no identical certificate yet" and store two. */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Resolves when every queued calculation has settled (tests, graceful shutdown). */
  async idle(): Promise<void> {
    await this.queue;
  }

  /** Recalculate one formula's current version; persists new certificates. */
  recalculateFormula(formulaId: string, trigger: string, actorId: string | null): Promise<FormulaCalcOutcome> {
    return this.serial(() => this.recalcOne(formulaId, trigger, actorId));
  }

  private async recalcOne(formulaId: string, trigger: string, actorId: string | null): Promise<FormulaCalcOutcome> {
    const current = await this.currentApprovedVersion(formulaId);
    if (!current) {
      return { formulaId, formulaVersionId: null, results: (['ifra', 'allergen'] as const).map((kind) => ({ kind, outcome: 'NO_APPROVED_VERSION' as const, missingCount: 0 })) };
    }
    const computed = await this.compute(current.formulaVersionId, { actorId, action: 'formula.compliance.calculate', reason: trigger });
    const ref = await this.formulaVersionRef(current.formulaVersionId);
    const results: FormulaCalcOutcome['results'] = [];
    for (const [kind, res, amendment] of [
      ['ifra', computed.ifra, computed.settings.ifraAmendment],
      ['allergen', computed.allergen, computed.settings.allergenListRef],
    ] as const) {
      let outcome: FormulaCalcOutcome['results'][number]['outcome'];
      let certificateId: string | null = null;
      if (res.ok) {
        const digest = createHash('sha256').update(JSON.stringify({ amendment, values: res.values })).digest('hex');
        const latest = (await this.db.select().from(complianceCertificate)
          .where(and(eq(complianceCertificate.formulaId, formulaId), eq(complianceCertificate.kind, kind)))
          .orderBy(desc(complianceCertificate.seq)).limit(1))[0];
        if (latest && latest.formulaVersionId === current.formulaVersionId && latest.valuesDigest === digest) {
          outcome = 'UNCHANGED'; certificateId = latest.certificateId;
        } else {
          certificateId = uuidv7();
          await this.db.insert(complianceCertificate).values({
            certificateId, formulaId, formulaVersionId: current.formulaVersionId, formulaVersionRef: ref, kind,
            amendment, certValues: res.values, valuesDigest: digest, calculatedAt: new Date(), calcTrigger: trigger.slice(0, 40),
            createdBy: actorId,
          });
          outcome = 'CERTIFIED';
        }
      } else {
        outcome = res.reason === 'missing_data' ? 'MISSING_DATA' : 'NOT_CONFIGURED';
      }
      const missingCount = res.ok ? 0 : res.missingMaterialIds.length;
      await this.db.insert(complianceCalcStatus).values({
        formulaId, kind, formulaVersionId: current.formulaVersionId, outcome, missingCount, lastCertificateId: certificateId, calculatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [complianceCalcStatus.formulaId, complianceCalcStatus.kind],
        set: { formulaVersionId: current.formulaVersionId, outcome, missingCount, lastCertificateId: certificateId, calculatedAt: new Date() },
      });
      results.push({ kind, outcome, missingCount });
    }
    return { formulaId, formulaVersionId: current.formulaVersionId, results };
  }

  /** Every formula with a current version. Sequential: each decrypt is audited and KMS-bound. */
  recalculateAll(trigger: string, actorId: string | null): Promise<FormulaCalcOutcome[]> {
    return this.serial(() => this.recalcAll(trigger, actorId));
  }

  private async recalcAll(trigger: string, actorId: string | null): Promise<FormulaCalcOutcome[]> {
    const formulas = await this.db.select({ formulaId: formulaMaster.formulaId }).from(formulaMaster).where(isNotNull(formulaMaster.currentVersionId));
    const out: FormulaCalcOutcome[] = [];
    for (const f of formulas) {
      try {
        out.push(await this.recalcOne(f.formulaId, trigger, actorId));
      } catch (err) {
        this.logger.warn(`compliance recalculation failed for formula ${f.formulaId}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Fire-and-forget recalculation of one formula (after an approval); logged, never thrown. */
  recalculateFormulaInBackground(formulaId: string, trigger: string, actorId: string | null): void {
    void this.recalculateFormula(formulaId, trigger, actorId)
      .catch((err: unknown) => this.logger.warn(`compliance recalculation failed for formula ${formulaId}: ${(err as Error).message}`));
  }

  /** Fire-and-forget recalculation after a data change; a failure is logged, never thrown. */
  recalculateAllInBackground(trigger: string, actorId: string | null): void {
    if (!this.autoRecalculate) return;
    void this.recalculateAll(trigger, actorId).catch((err: unknown) => this.logger.warn(`compliance recalculation failed: ${(err as Error).message}`));
  }

  /** The Vault console's calculation preview: numbers + notes + the materials lacking data
   *  (codes/names — Vault-authorised users only). Persists nothing. */
  async preview(formulaId: string, principal: AuthPrincipal) {
    const current = await this.currentApprovedVersion(formulaId);
    if (!current) throw new NotFoundException('this formula has no approved (or locked) current version to calculate');
    const computed = await this.compute(current.formulaVersionId, { actorId: principal.userId, action: 'formula.compliance.preview', reason: 'compliance preview' });
    const describe = async <V>(res: CalcResult<V>) => (res.ok
      ? { ok: true as const, values: res.values, notes: res.notes }
      : { ok: false as const, reason: res.reason, notes: res.notes, missingMaterials: await this.names(res.missingMaterialIds) });
    return {
      formulaId, versionNumber: current.versionNumber, settings: computed.settings,
      ifra: await describe(computed.ifra), allergen: await describe(computed.allergen),
    };
  }

  /** Which raw materials, used by a current approved formula, lack compliance data — and in which
   *  formulas. Vault-authorised users only (it names formula ingredients). */
  async missingDataReport(principal: AuthPrincipal) {
    const formulas = await this.db.select({ formulaId: formulaMaster.formulaId, formulaCode: formulaMaster.formulaCode })
      .from(formulaMaster).where(isNotNull(formulaMaster.currentVersionId));
    const materials = new Map<string, { ifraIn: Set<string>; allergenIn: Set<string> }>();
    const formulaRows: { formulaCode: string | null; ifra: string; allergen: string; missingCount: number }[] = [];
    for (const f of formulas) {
      const current = await this.currentApprovedVersion(f.formulaId);
      if (!current) continue;
      const c = await this.compute(current.formulaVersionId, { actorId: principal.userId, action: 'formula.compliance.missing_report', reason: 'missing-data report' });
      const ifraMissing = c.ifra.ok ? [] : c.ifra.missingMaterialIds;
      const allergenMissing = c.allergen.ok ? [] : c.allergen.missingMaterialIds;
      for (const id of ifraMissing) { const e = materials.get(id) ?? { ifraIn: new Set(), allergenIn: new Set() }; e.ifraIn.add(f.formulaCode ?? f.formulaId); materials.set(id, e); }
      for (const id of allergenMissing) { const e = materials.get(id) ?? { ifraIn: new Set(), allergenIn: new Set() }; e.allergenIn.add(f.formulaCode ?? f.formulaId); materials.set(id, e); }
      formulaRows.push({
        formulaCode: f.formulaCode,
        ifra: c.ifra.ok ? 'READY' : c.ifra.reason.toUpperCase(),
        allergen: c.allergen.ok ? 'READY' : c.allergen.reason.toUpperCase(),
        missingCount: new Set([...ifraMissing, ...allergenMissing]).size,
      });
    }
    const materialRows = [];
    for (const [id, e] of materials) {
      const m = await this.material(id);
      materialRows.push({
        materialCode: m?.materialCode ?? null, materialName: m?.materialName ?? '(not in catalogue)',
        missingIfra: e.ifraIn.size > 0, missingAllergen: e.allergenIn.size > 0,
        formulas: [...new Set([...e.ifraIn, ...e.allergenIn])].sort(),
      });
    }
    materialRows.sort((a, b) => String(a.materialCode ?? a.materialName).localeCompare(String(b.materialCode ?? b.materialName)));
    return { settings: await this.settings(), materials: materialRows, formulas: formulaRows };
  }

  /** Latest status per formula × kind, with the formula code (never a name) — the console list. */
  async calcStatuses() {
    const rows = await this.db.select({
      formulaId: complianceCalcStatus.formulaId, kind: complianceCalcStatus.kind, outcome: complianceCalcStatus.outcome,
      missingCount: complianceCalcStatus.missingCount, calculatedAt: complianceCalcStatus.calculatedAt,
      lastCertificateId: complianceCalcStatus.lastCertificateId, formulaCode: formulaMaster.formulaCode,
    }).from(complianceCalcStatus).leftJoin(formulaMaster, eq(formulaMaster.formulaId, complianceCalcStatus.formulaId))
      .orderBy(asc(formulaMaster.formulaCode), asc(complianceCalcStatus.kind));
    return rows;
  }

  /** The certificates calculated after `afterSeq` — the main box's pull (internal channel). */
  async certificatesAfter(afterSeq: number, limit: number): Promise<InternalCertificate[]> {
    const rows = await this.db.select().from(complianceCertificate)
      .where(gt(complianceCertificate.seq, afterSeq)).orderBy(asc(complianceCertificate.seq)).limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((r) => ({
      seq: Number(r.seq), certificateId: r.certificateId, formulaId: r.formulaId, formulaVersionRef: r.formulaVersionRef,
      kind: r.kind as CertificateKindName, amendment: r.amendment, values: r.certValues, calculatedAt: r.calculatedAt.toISOString(),
    }));
  }

  /* ── internals ───────────────────────────────────────────────────────────────────────── */

  private async compute(formulaVersionId: string, audit: { actorId: string | null; action: string; reason: string }) {
    const lines = await this.vault.decryptVersion(formulaVersionId, {
      actorId: audit.actorId, action: audit.action, entityType: 'formula_version', entityId: formulaVersionId, reason: audit.reason,
    });
    const formulaLines: FormulaLine[] = (lines ?? []).map((l) => ({ materialId: l.materialId, percentage: Number(l.percentage) }));
    const data = await this.loadMaterialData([...new Set(formulaLines.map((l) => l.materialId))]);
    const settings = await this.settings();
    const refs = await this.allergenReferences();
    return {
      settings,
      allergen: calculateAllergens(formulaLines, data, refs, settings.reportingThresholdPct),
      ifra: calculateIfra(formulaLines, data, settings.ifraAmendment),
    };
  }

  private async loadMaterialData(materialIds: string[]): Promise<Map<string, MaterialComplianceData>> {
    const out = new Map<string, MaterialComplianceData>();
    if (materialIds.length === 0) return out;
    const profiles = await this.db.select().from(rmComplianceProfile).where(inArray(rmComplianceProfile.materialId, materialIds));
    const allergens = await this.db.select().from(rmAllergenComposition).where(inArray(rmAllergenComposition.materialId, materialIds));
    const ifra = await this.db.select().from(rmIfraRestriction).where(inArray(rmIfraRestriction.materialId, materialIds));
    for (const p of profiles) {
      out.set(p.materialId, {
        materialId: p.materialId,
        allergenComplete: p.allergenComplete,
        ifraComplete: p.ifraComplete,
        ifraAmendment: p.ifraAmendment,
        allergens: allergens.filter((a) => a.materialId === p.materialId).map((a) => ({ cas: a.cas, naturalPct: toNum(a.naturalPct), syntheticPct: toNum(a.syntheticPct) })),
        ifra: ifra.filter((r) => r.materialId === p.materialId).map((r) => ({
          category: r.category, restrictionType: r.restrictionType as IfraRestrictionType,
          maxPct: r.maxPct === null ? null : Number(r.maxPct), amendment: r.amendment,
        })),
      });
    }
    return out;
  }

  private async currentApprovedVersion(formulaId: string) {
    const master = (await this.db.select({ currentVersionId: formulaMaster.currentVersionId }).from(formulaMaster).where(eq(formulaMaster.formulaId, formulaId)).limit(1))[0];
    if (!master) throw new NotFoundException(`formula not found: ${formulaId}`);
    if (!master.currentVersionId) return null;
    const v = (await this.db.select().from(formulaVersion).where(eq(formulaVersion.formulaVersionId, master.currentVersionId)).limit(1))[0];
    if (!v || (v.status !== 'APPROVED' && v.status !== 'LOCKED')) return null;
    return { formulaVersionId: v.formulaVersionId, versionNumber: v.versionNumber };
  }

  /** Opaque, stable per version, not derivable without the Vault's audit key. */
  async formulaVersionRef(formulaVersionId: string): Promise<string> {
    const mac = await this.kms.macAudit(`compliance.formula_version_ref:${formulaVersionId}`);
    return `fvr_${mac.slice(0, 32)}`;
  }

  private async replaceAllergens(tx: Parameters<Parameters<FormulaDb['transaction']>[0]>[0], materialId: string, rows: MaterialDataInput['allergens'], complete: boolean, principal: AuthPrincipal, sourceRef: string | null) {
    await tx.delete(rmAllergenComposition).where(eq(rmAllergenComposition.materialId, materialId));
    for (const a of rows) {
      await tx.insert(rmAllergenComposition).values({
        rmAllergenCompositionId: uuidv7(), materialId, cas: a.cas, naturalPct: String(a.naturalPct), syntheticPct: String(a.syntheticPct),
        status: 'ACTIVE', createdBy: principal.userId, updatedBy: principal.userId,
      });
    }
    await tx.insert(rmComplianceProfile).values({
      rmComplianceProfileId: uuidv7(), materialId, allergenComplete: complete, sourceRef, status: 'ACTIVE', createdBy: principal.userId, updatedBy: principal.userId,
    }).onConflictDoUpdate({ target: rmComplianceProfile.materialId, set: { allergenComplete: complete, sourceRef: sql`coalesce(${sourceRef}, ${rmComplianceProfile.sourceRef})`, updatedBy: principal.userId, updatedDt: new Date() } });
  }

  private async replaceIfra(tx: Parameters<Parameters<FormulaDb['transaction']>[0]>[0], materialId: string, rows: MaterialDataInput['ifra'], complete: boolean, amendment: string | null, principal: AuthPrincipal, sourceRef: string | null) {
    await tx.delete(rmIfraRestriction).where(eq(rmIfraRestriction.materialId, materialId));
    for (const r of rows) {
      await tx.insert(rmIfraRestriction).values({
        rmIfraRestrictionId: uuidv7(), materialId, amendment: r.amendment, category: r.category, restrictionType: r.restrictionType,
        maxPct: r.maxPct === null ? null : String(r.maxPct), status: 'ACTIVE', createdBy: principal.userId, updatedBy: principal.userId,
      });
    }
    await tx.insert(rmComplianceProfile).values({
      rmComplianceProfileId: uuidv7(), materialId, ifraComplete: complete, ifraAmendment: amendment, sourceRef, status: 'ACTIVE', createdBy: principal.userId, updatedBy: principal.userId,
    }).onConflictDoUpdate({ target: rmComplianceProfile.materialId, set: { ifraComplete: complete, ifraAmendment: amendment, sourceRef: sql`coalesce(${sourceRef}, ${rmComplianceProfile.sourceRef})`, updatedBy: principal.userId, updatedDt: new Date() } });
  }

  private async material(materialId: string): Promise<MaterialRef | null> {
    try {
      return await this.masterdata.findMaterial(materialId);
    } catch {
      return null; // the Vault's catalogue not yet pushed (restart) — callers show the id-less row
    }
  }

  private async materialByCode(code: string): Promise<MaterialRef | null> {
    const hits = await this.masterdata.searchMaterials(code, 50);
    return hits.find((h) => (h.materialCode ?? '').toLowerCase() === code.toLowerCase()) ?? null;
  }

  private async names(materialIds: string[]) {
    const out = [];
    for (const id of materialIds) {
      const m = await this.material(id);
      out.push({ materialCode: m?.materialCode ?? null, materialName: m?.materialName ?? '(not in catalogue)' });
    }
    return out;
  }

  private async writeAudit(principal: AuthPrincipal, action: string, entityId: string | null) {
    await this.vault.writeStandaloneAudit({ actorId: principal.userId, action, entityType: 'compliance_data', entityId });
  }
}

/* ── validation (pure; shared by the edit form and the import) ─────────────────────────────── */

export function isCas(v: string): boolean {
  const m = /^(\d{2,7})-(\d{2})-(\d)$/.exec(v);
  if (!m) return false;
  // CAS check digit: sum of each digit × its position from the right (excluding the check digit), mod 10.
  const digits = (m[1]! + m[2]!).split('').reverse().map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i + 1), 0);
  return sum % 10 === Number(m[3]);
}

function pct(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return 0;
  return Number(v);
}

export function validateAllergenRows(rows: MaterialDataInput['allergens'], regulated: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  for (const a of rows) {
    if (!regulated.has(a.cas)) errors.push(`CAS ${a.cas} is not on the regulated allergen list (add it to the list first)`);
    if (![a.naturalPct, a.syntheticPct].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) errors.push(`CAS ${a.cas}: percentages must be numbers 0..100`);
    else if (a.naturalPct + a.syntheticPct > 100) errors.push(`CAS ${a.cas}: natural + synthetic exceeds 100 %`);
  }
  const dupes = rows.map((r) => r.cas).filter((c, i, all) => all.indexOf(c) !== i);
  if (dupes.length > 0) errors.push(`duplicate CAS: ${[...new Set(dupes)].join(', ')}`);
  return errors;
}

export function validateIfraRows(rows: MaterialDataInput['ifra']): string[] {
  const errors: string[] = [];
  for (const r of rows) {
    if (!(IFRA_CATEGORIES as readonly string[]).includes(r.category)) errors.push(`"${r.category}" is not an IFRA category`);
    if (!(IFRA_RESTRICTION_TYPES as readonly string[]).includes(r.restrictionType)) errors.push(`"${r.restrictionType}" is not RESTRICTED, PROHIBITED or SPECIFICATION`);
    if (!r.amendment?.trim()) errors.push(`category ${r.category}: amendment is required`);
    if (r.restrictionType === 'RESTRICTED' && !(r.maxPct !== null && Number.isFinite(r.maxPct) && r.maxPct >= 0 && r.maxPct <= 100)) {
      errors.push(`category ${r.category}: a RESTRICTED row needs max_pct 0..100`);
    }
    if (r.restrictionType !== 'RESTRICTED' && r.maxPct !== null) errors.push(`category ${r.category}: only a RESTRICTED row carries max_pct`);
  }
  const dupes = rows.map((r) => r.category).filter((c, i, all) => all.indexOf(c) !== i);
  if (dupes.length > 0) errors.push(`duplicate category: ${[...new Set(dupes)].join(', ')}`);
  return errors;
}
