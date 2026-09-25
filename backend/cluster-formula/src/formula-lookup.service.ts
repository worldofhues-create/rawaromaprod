/**
 * FormulaLookupService — implements the `FORMULA_LOOKUP` public port. Both reads funnel
 * through `VaultService.decryptVersion` (approved-only + mandatory audit), then diverge on
 * what they let out:
 *   - getFloorView resolves each real material_id to its RM_ALIAS via MASTERDATA_LOOKUP and
 *     DROPS the material_id — the floor sees alias + % only.
 *   - resolvePickList / resolveManufacturingLines turn each real material_id into a KEYED
 *     material reference (material-ref.ts) and each percentage into the quantity for one
 *     order/batch, and drop both originals — what the main app box's production flow receives
 *     over the signed channel. They need no masterdata lookup at all, so the Vault box never has
 *     to call back into the main box to serve them.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@core/backend-kernel';
import { MASTERDATA_LOOKUP, type MasterdataLookup } from '@ra/cluster-masterdata';
import { VaultService } from './vault.service.js';
import { instructionQuantity, pickLineRequiredQty } from './pick-quantity.js';
import { materialRef, materialRefKey } from './material-ref.js';
import type {
  CodedInstruction,
  CodedMaterialLine,
  CodedPickLine,
  FloorIngredient,
  FormulaLookup,
  ReadContext,
} from './public-api.js';

@Injectable()
export class FormulaLookupService implements FormulaLookup {
  constructor(
    private readonly vault: VaultService,
    @Inject(MASTERDATA_LOOKUP) private readonly masterdata: MasterdataLookup,
    // INTERNAL_BRIDGE_KEY, for the keyed material references of the main-box reads. Optional so
    // the in-process reads that don't need it (floor view, alias instruction) construct without it.
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService,
  ) {}

  /** The material-ref key; refuses (never an unkeyed fallback) when INTERNAL_BRIDGE_KEY is unset. */
  private refKey(): Buffer {
    const key = this.config?.get('INTERNAL_BRIDGE_KEY');
    if (!key) {
      throw new Error('INTERNAL_BRIDGE_KEY is not configured — the Vault cannot code material references for the main box.');
    }
    return materialRefKey(key);
  }

  async getFloorView(
    formulaVersionId: string,
    ctx: ReadContext,
  ): Promise<FloorIngredient[] | null> {
    const ingredients = await this.vault.decryptVersion(formulaVersionId, {
      actorId: ctx.actorId,
      action: 'formula.floor.read',
      entityType: 'formula_version',
      entityId: formulaVersionId,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    if (!ingredients) return null;

    // Resolve material → alias; the real material_id is dropped here and never returned.
    return Promise.all(
      ingredients.map(async (i) => {
        const alias = await this.masterdata.findAliasForMaterial(i.materialId);
        return {
          rmAliasId: alias?.rmAliasId ?? null,
          aliasName: alias?.aliasName ?? null,
          percentage: i.percentage,
          sequenceNo: i.sequenceNo,
        };
      }),
    );
  }

  /**
   * §109.7 `VaultPort.resolveManufacturingInstruction`. Decrypts (approved-only + audited,
   * same chokepoint as getFloorView), then converts each ingredient's raw formula PERCENTAGE
   * into an absolute QUANTITY for this specific `permittedBatchQuantity`. P0 DECISION: the
   * quantity is kept (not further reduced) because weigh/dispense on the floor genuinely
   * needs an absolute number — masking stops at material identity (alias, not material_id),
   * not at the number itself.
   *
   * HONEST derivability note (the prior comment here overstated the guarantee): the
   * PERCENTAGE itself is NOT transmitted, but it is mathematically DERIVABLE by anyone who
   * has both this quantity and the order's `permittedBatchQuantity` (percentage =
   * quantity / permittedBatchQuantity × 100) — and `permittedBatchQuantity` is the order's own
   * `order_qty`, visible to any `production:production_order:read` holder. So "the percentage
   * never leaves" is only true in the narrow sense that no field literally named `percentage`
   * is serialized; a caller who can see both this response and the order's qty can reconstruct
   * it exactly. What genuinely never leaves, and is the actual boundary this route protects,
   * is the real `material_id` (dropped, resolved to an alias) and any OTHER formula this order
   * doesn't cover. Access is therefore restricted at the route (production + compounding only,
   * `production:manufacturing_instruction:read`, active orders only) and every resolution is
   * audited — see PickingController/PickingService.
   */
  async resolveManufacturingInstruction(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedInstruction[] | null> {
    const ingredients = await this.vault.decryptVersion(formulaVersionId, {
      actorId: ctx.actorId,
      action: 'formula.manufacturing_instruction.resolve',
      entityType: 'formula_version',
      entityId: formulaVersionId,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    if (!ingredients) return null;

    return Promise.all(
      ingredients.map(async (i) => {
        const alias = await this.masterdata.findAliasForMaterial(i.materialId);
        const quantity = instructionQuantity(i.percentage, permittedBatchQuantity);
        return {
          code: alias?.aliasName ?? null,
          quantity,
          uom: 'kg',
          sequenceNo: i.sequenceNo,
        };
      }),
    );
  }

  /**
   * The coded bill of materials for one production order (see `CodedPickLine`). Same chokepoint
   * as every other read (approved/locked only, audited as `formula.picklist.read` — the action
   * the Vault console's audit view already files under manufacturing reads). Each material_id
   * becomes its keyed reference and each percentage the required quantity for `orderQty`
   * (pick-quantity.ts, identical to what the main box used to compute); both originals are dropped.
   */
  async resolvePickList(
    formulaVersionId: string,
    orderQty: number,
    ctx: ReadContext,
  ): Promise<CodedPickLine[] | null> {
    const key = this.refKey();
    const ingredients = await this.vault.decryptVersion(formulaVersionId, {
      actorId: ctx.actorId,
      action: 'formula.picklist.read',
      entityType: 'formula_version',
      entityId: formulaVersionId,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    if (!ingredients) return null;
    return ingredients.map((i) => ({
      materialRef: materialRef(key, i.materialId),
      requiredQty: pickLineRequiredQty(orderQty, i.percentage),
      sequenceNo: i.sequenceNo,
    }));
  }

  /**
   * `resolveManufacturingInstruction` for the main box: same audit action
   * (`formula.manufacturing_instruction.resolve`), same approval rule, same quantities
   * (`instructionQuantity`), with each material as its keyed reference instead of a floor code the
   * Vault would have to fetch from the main box. The main box resolves the floor code itself.
   */
  async resolveManufacturingLines(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedMaterialLine[] | null> {
    const key = this.refKey();
    const ingredients = await this.vault.decryptVersion(formulaVersionId, {
      actorId: ctx.actorId,
      action: 'formula.manufacturing_instruction.resolve',
      entityType: 'formula_version',
      entityId: formulaVersionId,
      requestId: ctx.requestId,
      ip: ctx.ip,
    });
    if (!ingredients) return null;
    return ingredients.map((i) => ({
      materialRef: materialRef(key, i.materialId),
      quantity: instructionQuantity(i.percentage, permittedBatchQuantity),
      uom: 'kg',
      sequenceNo: i.sequenceNo,
    }));
  }
}
