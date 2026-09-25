/**
 * formula vault — PUBLIC API. This is the ONLY door out of the vault, and it is deliberately
 * narrow. The real recipe (material_id + percentage) is sealed at rest; nothing crosses this
 * boundary un-decrypted, and every read here writes a hash-chained audit row in the same
 * transaction (no un-audited read is possible).
 *
 * The reads, none of which lets the real material_id out:
 *   - getFloorView  → ALIAS + percentage only. What the production floor / any UI may see.
 *                     The real material_id is resolved to its RM_ALIAS inside the vault and
 *                     DROPPED; it never leaves. This is the masking guarantee.
 *   - resolveManufacturingInstruction → §109.7's `VaultPort.resolveManufacturingInstruction`.
 *                     CODE + a per-batch QUANTITY (never the raw formula percentage — the
 *                     underlying recipe ratio never crosses this boundary in its own units).
 *                     "Factory production does not read formula plaintext." Client-facing,
 *                     production-permission-gated (FormulasController).
 *   - resolvePickList / resolveManufacturingLines → what the MAIN app box's production flow reads
 *                     over the signed internal channel (`VaultPort`, vault-port.ts; the main box
 *                     has no formula-DB connection): per line a KEYED material reference
 *                     (material-ref.ts — opaque without INTERNAL_BRIDGE_KEY, never the
 *                     material_id or an alias), the quantity for this order/batch and the sequence
 *                     number. The main box maps each reference to its OWN masterdata material row
 *                     (and that material's floor code). The raw percentage never leaves.
 *                     (resolvePickList replaces the former `getPickList`, which returned
 *                     material_id + % and was read off the main box's own formula-DB connection.)
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

/**
 * §109.7 — one coded/masked manufacturing line: `RM-A123  2.75 kg`. `code` is the RM_ALIAS
 * (never the real material_id); `quantity` is resolved FOR THIS `permittedBatchQuantity`
 * (never the formula's raw percentage — that unit never leaves the vault). "The mapping
 * from code to protected material/formula identity stays inside Vault authority."
 */
export interface CodedInstruction {
  code: string | null;
  quantity: number;
  uom: string;
  sequenceNo: number | null;
}

/**
 * One line of a production order's bill of materials as it crosses the internal channel to the
 * main app box (`resolvePickList`). No material_id, no alias, no percentage, no formula name.
 */
export interface CodedPickLine {
  /** Keyed reference to the line's material (material-ref.ts); the main box resolves it. */
  materialRef: string;
  /**
   * Required quantity for THIS order_qty, as a decimal string at
   * `production_order_ingredients.required_qty`'s scale (numeric(18,4)) — see pick-quantity.ts.
   */
  requiredQty: string;
  sequenceNo: number | null;
}

/**
 * One §109.7 manufacturing-instruction line as it crosses the internal channel
 * (`resolveManufacturingLines`): the same quantity/uom/sequence as `CodedInstruction`, with a keyed
 * material reference in place of the floor code — the main box resolves the floor code itself.
 */
export interface CodedMaterialLine {
  materialRef: string;
  quantity: number;
  uom: string;
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
  /**
   * §109.7 `VaultPort.resolveManufacturingInstruction(approved_formula_version,
   * permitted_batch_quantity)`. Audited. Returns null only if the version row doesn't exist;
   * throws (refuses, also audited) if it exists but isn't approved/locked yet.
   */
  resolveManufacturingInstruction(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedInstruction[] | null>;
  /**
   * The coded bill of materials for a production order of `orderQty` (see `CodedPickLine`).
   * Audited as `formula.picklist.read`. Returns null only if the version row doesn't exist;
   * throws (refuses, also audited) if it exists but isn't approved/locked yet.
   */
  resolvePickList(formulaVersionId: string, orderQty: number, ctx: ReadContext): Promise<CodedPickLine[] | null>;
  /**
   * `resolveManufacturingInstruction`'s lines for the main box (see `CodedMaterialLine`): same
   * audit action, same approval rule, same quantities — keyed material references instead of
   * floor codes, so the Vault needs no call back into the main box.
   */
  resolveManufacturingLines(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedMaterialLine[] | null>;
}

/** DI token for `FormulaLookup`. */
export const FORMULA_LOOKUP = Symbol('FORMULA_LOOKUP');
