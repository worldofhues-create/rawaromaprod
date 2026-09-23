/**
 * FormulaLookupService — implements the `FORMULA_LOOKUP` public port. Both reads funnel
 * through `VaultService.decryptVersion` (approved-only + mandatory audit), then diverge on
 * what they let out:
 *   - getFloorView resolves each real material_id to its RM_ALIAS via MASTERDATA_LOOKUP and
 *     DROPS the material_id — the floor sees alias + % only.
 *   - getPickList returns the real material_id + % for server-side material issue and is
 *     never serialized to a client (no controller route maps it).
 */
import { Inject, Injectable } from '@nestjs/common';
import { MASTERDATA_LOOKUP, type MasterdataLookup } from '@ra/cluster-masterdata';
import { VaultService } from './vault.service.js';
import type {
  CodedInstruction,
  FloorIngredient,
  FormulaLookup,
  PickIngredient,
  ReadContext,
} from './public-api.js';

@Injectable()
export class FormulaLookupService implements FormulaLookup {
  constructor(
    private readonly vault: VaultService,
    @Inject(MASTERDATA_LOOKUP) private readonly masterdata: MasterdataLookup,
  ) {}

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
        const quantity = Math.round((i.percentage / 100) * permittedBatchQuantity * 1000) / 1000;
        return {
          code: alias?.aliasName ?? null,
          quantity,
          uom: 'kg',
          sequenceNo: i.sequenceNo,
        };
      }),
    );
  }

  async getPickList(
    formulaVersionId: string,
    ctx: ReadContext,
  ): Promise<PickIngredient[] | null> {
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
      materialId: i.materialId,
      percentage: i.percentage,
      sequenceNo: i.sequenceNo,
    }));
  }
}
