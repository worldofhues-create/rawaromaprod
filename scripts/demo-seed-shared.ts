/**
 * demo-seed-shared.ts — the DETERMINISTIC ID CONTRACT between demo-seed.ts's two phases.
 *
 * P0 decision (2026-09-24, lane FIXV): demo formula seeding must run ON THE VAULT BOX (formula
 * data written straight into `vault_demo` by the vault-main services, in VAULT_MODE) — there is
 * NO new network path from the app box to vault-pg. That means the FACTORY phase (app box,
 * `rawprod_demo`) and the VAULT phase (vault box, `vault_demo`) run as separate processes
 * against separate Postgres instances, with no ability to query each other's database.
 *
 * Two entity kinds cross that boundary by REFERENCE, not by network call:
 *   - material ids: the vault phase seals `{materialId, percentage}` pairs into formula
 *     ingredients; those material ids must resolve to REAL `masterdata.material` rows the
 *     factory phase creates, so PickingService/PlanningService (factory-side, real production
 *     code) and the Vault's own `getFloorView`/alias resolution agree on the same materials.
 *   - formula ids (+ version ids): the factory phase writes `packaging.product_master.formula_id`
 *     / production orders' `formula_version_id`, which must resolve to the REAL `formula.
 *     formula_master`/`formula_version` rows the vault phase creates.
 *
 * Rather than have either phase query the other over a signed bridge (which needs a live HTTP
 * server up during a one-off seed run, and doesn't resolve the reverse direction at all — see
 * `formulas/formulas.service.ts` and `material.service.ts`'s own doc comments on the two small,
 * script-only `override*Id` escape hatches this file's ids are fed through), both phases instead
 * derive the SAME id independently from the SAME natural business key (material/formula code),
 * via a pure, non-secret, sha256-based function. Neither phase needs the other to have run first,
 * be reachable, or even exist yet — this is what makes `reset-demo.sh` free to run them in
 * whichever order (or in parallel) ops finds convenient.
 *
 * Never used for anything secret. A label collision is the only failure mode, and every label
 * below is namespaced by kind, so this is safe to keep alongside (never instead of) the real
 * uuidv7() ids every other created row still gets.
 */
import { createHash } from 'node:crypto';

/** Deterministic, stable pseudo-UUID derived from a label. */
export function demoDeterministicId(label: string): string {
  const h = createHash('sha256').update(`RAWPROD-DEMO-SEED-ID::${label}`).digest('hex');
  // Shaped like a UUID (version nibble '4', variant nibble in the 8-b range) purely so it passes
  // every `z.string().uuid()` / `uuid` column check in the schema — it is NOT a real random v4
  // UUID and must never be treated as one for anything security-sensitive.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const demoMaterialId = (materialCode: string): string => demoDeterministicId(`material:${materialCode}`);
export const demoFormulaId = (formulaCode: string): string => demoDeterministicId(`formula:${formulaCode}`);
export const demoFormulaVersionId = (formulaCode: string, versionNumber: number): string =>
  demoDeterministicId(`formula-version:${formulaCode}:${versionNumber}`);

/* ── shared small helpers (moved out of demo-seed.ts so both phases can use them) ────────── */

export const pick = <T>(arr: readonly T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length]!;

const SHARE_TABLE: Record<number, number[]> = {
  8: [30, 20, 15, 12, 10, 8, 3, 2],
  6: [35, 25, 15, 10, 10, 5],
};
export function sharesFor(n: number): number[] {
  const t = SHARE_TABLE[n];
  if (t) return t;
  const base = Math.floor(100 / n);
  const arr = Array.from({ length: n }, () => base);
  arr[0] = arr[0]! + (100 - base * n);
  return arr;
}

/* ── materials: 60 fully deterministic codes (DEMO-MAT-0001..0060) ──────────────────────── */

export const MATERIAL_COUNT = 60;
export const MATERIAL_FAMILIES = [
  'Citrus Accord', 'Floral Heart', 'Woody Base', 'Amber Blend', 'Green Note', 'Musk Base',
  'Spice Accord', 'Aquatic Note', 'Powdery Base', 'Fruity Accord',
] as const;

/** `materials[i]`'s code, for `i` in `0..MATERIAL_COUNT-1` — matches `ensureMaterials`'s own
 * `DEMO-MAT-${String(i + 1).padStart(4, '0')}` naming exactly. */
export function demoMaterialCodeAt(i: number): string {
  return `DEMO-MAT-${String(i + 1).padStart(4, '0')}`;
}

export function demoMaterialNameAt(i: number): string {
  const family = pick(MATERIAL_FAMILIES, i);
  const variant = String(Math.floor(i / MATERIAL_FAMILIES.length) + 1).padStart(2, '0');
  return `Demo ${family} ${variant}`;
}

/** The code `pick(materials, seed)` would have selected, computed WITHOUT the `materials`
 * array (`ensureMaterials`'s output) ever existing — see this file's header. */
function demoMaterialCodeForSeed(seed: number): string {
  const i = ((seed % MATERIAL_COUNT) + MATERIAL_COUNT) % MATERIAL_COUNT;
  return demoMaterialCodeAt(i);
}

/* ── formulas: 2 fixed demo formulas ─────────────────────────────────────────────────────── */

export interface DemoFormulaDef { code: string; name: string; ingredientCount: number; }
export const DEMO_FORMULA_DEFS: readonly DemoFormulaDef[] = [
  { code: 'DEMO-FRM-001', name: 'Demo Signature Accord', ingredientCount: 8 },
  { code: 'DEMO-FRM-002', name: 'Demo Citrus Veil', ingredientCount: 6 },
];

export interface DemoIngredientPlanItem {
  materialCode: string;
  materialId: string;
  percentage: number;
  sequenceNo: number;
}

/** The exact `{materialId, percentage, sequenceNo}` set `ensureFormulaVault` seals for demo
 * formula index `formulaIndex` (0-based, into `DEMO_FORMULA_DEFS`) — a pure function of the
 * formula's own `ingredientCount`, so the VAULT phase (sealing) and the FACTORY phase (building
 * a local, no-network-needed pick list / coded manufacturing instruction for
 * PlanningService/PickingService — see `demo-seed.ts`'s `buildStaticFormulaPort`) always agree,
 * with no query between them. */
export function demoFormulaIngredientPlan(formulaIndex: number, ingredientCount: number): DemoIngredientPlanItem[] {
  const shares = sharesFor(ingredientCount);
  return Array.from({ length: ingredientCount }, (_, i) => {
    const materialCode = demoMaterialCodeForSeed(formulaIndex * 17 + i * 7);
    return {
      materialCode,
      materialId: demoMaterialId(materialCode),
      percentage: shares[i]!,
      sequenceNo: i + 1,
    };
  });
}
