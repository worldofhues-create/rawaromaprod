/**
 * masterdata cluster — PUBLIC API. Other clusters (procurement, production, quality…)
 * hold material ids as soft refs and occasionally need a cold read to resolve the
 * material's code/name/uom, or its masking alias. The only surface we expose is the
 * `MasterdataLookup` read port (id + code/name refs only). Inject by `MASTERDATA_LOOKUP`.
 */

export interface MaterialRef {
  materialId: string;
  materialCode: string | null;
  materialName: string | null;
  uomId: string | null;
}

export interface AliasRef {
  rmAliasId: string;
  aliasName: string | null;
}

/** Cold read port into the masterdata masters. */
export interface MasterdataLookup {
  findMaterial(materialId: string): Promise<MaterialRef | null>;
  findAliasForMaterial(materialId: string): Promise<AliasRef | null>;
  /**
   * Batch resolve: material_id → its latest RM alias, for the response-masking interceptor.
   * Returns a map keyed by material_id; a material with no alias is simply absent from the map.
   */
  findAliasesForMaterials(materialIds: string[]): Promise<Map<string, AliasRef>>;
}

/** DI token for `MasterdataLookup`. */
export const MASTERDATA_LOOKUP = Symbol('MASTERDATA_LOOKUP');
