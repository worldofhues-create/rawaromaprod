/**
 * formula vault — PUBLIC API. This is the ONLY door out of the vault, and it is deliberately
 * narrow. The real recipe (material_id + percentage) is sealed at rest; nothing crosses this
 * boundary un-decrypted, and every read here writes a hash-chained audit row in the same
 * transaction (no un-audited read is possible).
 *
 * Two reads, two trust levels:
 *   - getFloorView  → ALIAS + percentage only. What the production floor / any UI may see.
 *                     The real material_id is resolved to its RM_ALIAS inside the vault and
 *                     DROPPED; it never leaves. This is the masking guarantee.
 *   - getPickList   → real material_id + percentage. SERVER-SIDE ONLY — consumed by
 *                     production's material-issue to compute inventory decrements. Must never
 *                     be serialized to a client response. Edge layer does not expose it.
 *
 * Inject by the `FORMULA_LOOKUP` token; never sync-import the vault internals.
 */

/** A masked ingredient — what the floor is allowed to see. No material_id. */
export interface FloorIngredient {
  rmAliasId: string | null;
  aliasName: string | null;
  percentage: number;
  sequenceNo: number | null;
}

/** A real ingredient — server-side pick list for material issue. Never client-facing. */
export interface PickIngredient {
  materialId: string;
  percentage: number;
  sequenceNo: number | null;
}

/** Who is reading + why — threaded into the mandatory audit row. */
export interface ReadContext {
  actorId: string | null;
  requestId?: string | null;
  ip?: string | null;
}

export interface FormulaLookup {
  /** Masked recipe (alias + %). Audited. Returns null if the version isn't approved/locked. */
  getFloorView(formulaVersionId: string, ctx: ReadContext): Promise<FloorIngredient[] | null>;
  /** Real pick list (material_id + %) for SERVER-SIDE material issue. Audited. */
  getPickList(formulaVersionId: string, ctx: ReadContext): Promise<PickIngredient[] | null>;
}

/** DI token for `FormulaLookup`. */
export const FORMULA_LOOKUP = Symbol('FORMULA_LOOKUP');
