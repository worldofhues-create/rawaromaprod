/**
 * ProductionVaultPort — `VAULT_PORT` on the main app box: the formula reads the production flow
 * makes, answered by the Formula Vault over the signed internal channel (`VaultApiClient`) and
 * finished HERE against this box's own masterdata. The main box has no formula-database connection.
 *
 * The Vault names each line's material by a keyed reference (`materialRef`, material-ref.ts in
 * @ra/cluster-formula), never a material_id or an alias, and needs no call back into this box to do
 * it. This class turns a reference into this box's material row by computing the reference of each
 * `masterdata.material` id with the same key, and takes that material's floor code (its latest RM
 * alias — the same one the Vault's own alias lookup picks) from `masterdata.rm_alias`.
 *
 *   resolvePickList → PlanningService.createOrder: material_id + required quantity per line. A
 *     reference this factory's master data does not know refuses the order (409), naming only
 *     sequence numbers.
 *   resolveManufacturingInstruction → PickingService / WeighingService: floor code + quantity + uom.
 *     A material with no floor code (or an unknown reference) comes back `code: null`; both callers
 *     already refuse such a line (409).
 */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@core/backend-kernel';
import {
  VaultApiClient,
  materialRef,
  materialRefKey,
  type CodedInstruction,
  type PickLine,
  type ReadContext,
  type VaultPort,
} from '@ra/cluster-formula';
import { PRODUCTION_DB, type ProductionDb } from '../production.tokens.js';

interface MaterialEntry {
  materialId: string;
  floorCode: string | null;
}

@Injectable()
export class ProductionVaultPort implements VaultPort {
  constructor(
    @Inject(VaultApiClient) private readonly client: VaultApiClient,
    @Inject(PRODUCTION_DB) private readonly db: ProductionDb,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async resolvePickList(formulaVersionId: string, orderQty: number, ctx: ReadContext): Promise<PickLine[] | null> {
    const lines = await this.client.pickList(formulaVersionId, orderQty, ctx);
    if (!lines) return null;
    const index = await this.materialIndex(lines.map((l) => l.materialRef));
    const unknown = lines.filter((l) => !index.has(l.materialRef));
    if (unknown.length > 0) {
      throw new ConflictException(
        `${unknown.length} formula line(s) (sequence ${unknown.map((l) => l.sequenceNo ?? '?').join(', ')}) `
          + 'name a material this factory\'s master data does not have — cannot start production.',
      );
    }
    return lines.map((l) => ({
      materialId: index.get(l.materialRef)!.materialId,
      requiredQty: l.requiredQty,
      sequenceNo: l.sequenceNo,
    }));
  }

  async resolveManufacturingInstruction(
    formulaVersionId: string,
    permittedBatchQuantity: number,
    ctx: ReadContext,
  ): Promise<CodedInstruction[] | null> {
    const lines = await this.client.manufacturingLines(formulaVersionId, permittedBatchQuantity, ctx);
    if (!lines) return null;
    const index = await this.materialIndex(lines.map((l) => l.materialRef));
    return lines.map((l) => ({
      code: index.get(l.materialRef)?.floorCode ?? null,
      quantity: l.quantity,
      uom: l.uom,
      sequenceNo: l.sequenceNo,
    }));
  }

  /** reference -> { material_id, floor code } for the requested references, from this box's masterdata. */
  private async materialIndex(refs: string[]): Promise<Map<string, MaterialEntry>> {
    const wanted = new Set(refs);
    const out = new Map<string, MaterialEntry>();
    if (wanted.size === 0) return out;
    const bridgeKey = this.config.get('INTERNAL_BRIDGE_KEY');
    if (!bridgeKey) throw new Error('INTERNAL_BRIDGE_KEY is not configured — cannot resolve the Vault\'s material references.');
    const key = materialRefKey(bridgeKey);
    const rows = (await this.db.execute(sql`
      select m.material_id::text as "materialId",
             (select a.alias_name from masterdata.rm_alias a
               where a.material_id = m.material_id order by a.rm_alias_id desc limit 1) as "floorCode"
        from masterdata.material m`)) as unknown as MaterialEntry[];
    for (const row of Array.from(rows)) {
      const ref = materialRef(key, row.materialId);
      if (wanted.has(ref)) {
        out.set(ref, { materialId: row.materialId, floorCode: row.floorCode ?? null });
        if (out.size === wanted.size) break;
      }
    }
    return out;
  }
}
