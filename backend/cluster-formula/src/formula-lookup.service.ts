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
   * into an absolute QUANTITY for this specific `permittedBatchQuantity` — the recipe's own
   * unit (a %, reusable across every batch size) never leaves; what leaves is a number that
   * is only meaningful for THIS production order. The real material_id is resolved to its
   * RM_ALIAS code and dropped, same as getFloorView.
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
