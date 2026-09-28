/**
 * The Vault's compliance calculation engine — pure functions, no I/O (owner ruling 2026-09-28,
 * item 2). Runs ONLY inside the Vault, over a decrypted formula version and the raw-material
 * compliance data the regulatory team entered/imported. Its output is certificate NUMBERS only:
 * no ingredient, no material id, no percentage ever appears in a result's `values`.
 *
 * ALLERGENS (per regulated allergen, by CAS):
 *   natural  = Σ over ingredients (ingredient % in fragrance × allergen % from natural sources in
 *              that raw material) / 100
 *   synthetic= the same over the synthetic-source %
 *   total    = natural + synthetic
 *   Each of the three is reported as 'A' when it is zero or below the reporting threshold (a Vault
 *   setting; default 0, i.e. only an exact zero is 'A'). Numbers are rounded to 6 decimals — the
 *   threshold is compared against the UNROUNDED value.
 *
 * IFRA (per category 1..12 incl. 5A-5D, 7A/7B, 10A/10B, 11A/11B):
 *   limit(category) = min over the formula's ingredients restricted in that category of
 *                     (ingredient's max % in the finished product / ingredient % in the fragrance)
 *                     × 100
 *   capped at 100 %; an ingredient PROHIBITED in the category (present at any level) makes it 0 %;
 *   a category with no restricted ingredient is 100 %. A SPECIFICATION-type standard carries no
 *   numeric limit and does not change the number (the preview lists it so the regulatory team can
 *   confirm the specification is met). Limits are rounded DOWN to 2 decimals — a certificate may
 *   understate a use level, never overstate it.
 *
 * MISSING DATA: every ingredient must have a compliance profile marking its allergen data (resp.
 * IFRA data) complete — an explicit "no allergens / not restricted" is a completed profile with no
 * rows; the absence of a profile is NOT read as "nothing to declare". IFRA data must also be for
 * the amendment the Vault is configured with. Any gap → no certificate of that kind, and the
 * result names the material ids that lack data (the caller turns those into names, and only for
 * Vault-authorised users).
 */

/** Every IFRA product category of the current (48th+) category scheme, in certificate order. */
export const IFRA_CATEGORIES = [
  '1', '2', '3', '4', '5A', '5B', '5C', '5D', '6', '7A', '7B', '8', '9', '10A', '10B', '11A', '11B', '12',
] as const;
export type IfraCategory = (typeof IFRA_CATEGORIES)[number];

export const IFRA_RESTRICTION_TYPES = ['RESTRICTED', 'PROHIBITED', 'SPECIFICATION'] as const;
export type IfraRestrictionType = (typeof IFRA_RESTRICTION_TYPES)[number];

/** One decrypted formula line (never leaves the Vault). */
export interface FormulaLine {
  readonly materialId: string;
  /** % of this raw material in the fragrance (0..100). */
  readonly percentage: number;
}

export interface AllergenComposition {
  readonly cas: string;
  /** % of the allergen in the raw material, from natural sources. */
  readonly naturalPct: number;
  /** % of the allergen in the raw material, from synthetic sources. */
  readonly syntheticPct: number;
}

export interface IfraRestriction {
  readonly category: string;
  readonly restrictionType: IfraRestrictionType;
  /** Max % of the raw material in the finished consumer product; null unless RESTRICTED. */
  readonly maxPct: number | null;
  readonly amendment: string;
}

export interface MaterialComplianceData {
  readonly materialId: string;
  readonly allergenComplete: boolean;
  readonly allergens: readonly AllergenComposition[];
  readonly ifraComplete: boolean;
  /** The IFRA amendment the completeness declaration was made against. */
  readonly ifraAmendment: string | null;
  readonly ifra: readonly IfraRestriction[];
}

export interface AllergenReference {
  readonly name: string;
  readonly cas: string;
}

export type Amount = number | 'A';

export interface AllergenValue {
  readonly name: string;
  readonly cas: string;
  readonly natural: Amount;
  readonly synthetic: Amount;
  readonly total: Amount;
}

export interface IfraValue {
  readonly category: string;
  readonly limitPct: number;
}

export type CalcResult<V> =
  | { readonly ok: true; readonly values: V[]; readonly notes: string[] }
  | { readonly ok: false; readonly reason: 'missing_data' | 'not_configured' | 'empty_formula'; readonly missingMaterialIds: string[]; readonly notes: string[] };

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
const floorTo = (v: number, dp: number) => Math.floor(v * 10 ** dp + 1e-9) / 10 ** dp;

/** Sum duplicate lines of the same material (a material may appear on more than one line). */
export function aggregateLines(lines: readonly FormulaLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (!(l.percentage > 0)) continue;
    out.set(l.materialId, (out.get(l.materialId) ?? 0) + l.percentage);
  }
  return out;
}

function amount(v: number, threshold: number): Amount {
  if (v <= 0 || v < threshold) return 'A';
  return round(v, 6);
}

export function calculateAllergens(
  lines: readonly FormulaLine[],
  data: ReadonlyMap<string, MaterialComplianceData>,
  references: readonly AllergenReference[],
  reportingThreshold: number,
): CalcResult<AllergenValue> {
  const notes: string[] = [];
  const byMaterial = aggregateLines(lines);
  if (byMaterial.size === 0) return { ok: false, reason: 'empty_formula', missingMaterialIds: [], notes };
  if (references.length === 0) {
    return { ok: false, reason: 'not_configured', missingMaterialIds: [], notes: ['no regulated allergen list is configured'] };
  }
  const missing = [...byMaterial.keys()].filter((id) => !data.get(id)?.allergenComplete);
  if (missing.length > 0) return { ok: false, reason: 'missing_data', missingMaterialIds: missing.sort(), notes };

  const natural = new Map<string, number>();
  const synthetic = new Map<string, number>();
  const listed = new Set(references.map((r) => r.cas));
  for (const [materialId, pct] of byMaterial) {
    for (const a of data.get(materialId)!.allergens) {
      if (!listed.has(a.cas)) {
        notes.push(`allergen data for CAS ${a.cas} is not on the regulated list and is not reported`);
        continue;
      }
      natural.set(a.cas, (natural.get(a.cas) ?? 0) + (pct * a.naturalPct) / 100);
      synthetic.set(a.cas, (synthetic.get(a.cas) ?? 0) + (pct * a.syntheticPct) / 100);
    }
  }
  const values = references.map((r) => {
    const n = natural.get(r.cas) ?? 0;
    const s = synthetic.get(r.cas) ?? 0;
    return { name: r.name, cas: r.cas, natural: amount(n, reportingThreshold), synthetic: amount(s, reportingThreshold), total: amount(n + s, reportingThreshold) };
  });
  return { ok: true, values, notes: [...new Set(notes)] };
}

export function calculateIfra(
  lines: readonly FormulaLine[],
  data: ReadonlyMap<string, MaterialComplianceData>,
  amendment: string | null,
): CalcResult<IfraValue> {
  const notes: string[] = [];
  const byMaterial = aggregateLines(lines);
  if (byMaterial.size === 0) return { ok: false, reason: 'empty_formula', missingMaterialIds: [], notes };
  if (!amendment) {
    return { ok: false, reason: 'not_configured', missingMaterialIds: [], notes: ['the IFRA amendment in force is not configured'] };
  }
  // Complete, AND every restriction row is for the configured amendment (a row for an older
  // amendment is stale data: the material needs re-entering against the one in force).
  const missing = [...byMaterial.keys()].filter((id) => {
    const d = data.get(id);
    return !d?.ifraComplete || d.ifraAmendment !== amendment || d.ifra.some((r) => r.amendment !== amendment);
  });
  if (missing.length > 0) return { ok: false, reason: 'missing_data', missingMaterialIds: missing.sort(), notes };

  const values = IFRA_CATEGORIES.map((category) => {
    let limit = 100;
    for (const [materialId, pct] of byMaterial) {
      const r = data.get(materialId)!.ifra.find((x) => x.category === category);
      if (!r) continue;
      if (r.restrictionType === 'PROHIBITED') limit = 0;
      else if (r.restrictionType === 'RESTRICTED' && r.maxPct !== null) limit = Math.min(limit, (r.maxPct / pct) * 100);
      else if (r.restrictionType === 'SPECIFICATION') notes.push(`category ${category}: a specification-type standard applies — confirm it is met`);
    }
    return { category, limitPct: floorTo(Math.min(100, Math.max(0, limit)), 2) };
  });
  return { ok: true, values, notes: [...new Set(notes)] };
}
