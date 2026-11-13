/**
 * @ra/cluster-masterdata — the RAW AROMACHEM masterdata cluster module + its public port.
 *
 * Exports the module (composed by `api`), the `MASTERDATA_DB` token (for the worker that
 * drains this cluster's outbox), and the `MASTERDATA_LOOKUP` cold-read port + its types.
 */
export { ClusterMasterdataModule } from './cluster-masterdata.module.js';
export {
  MASTERDATA_DB,
  type MasterdataDb,
} from './cluster-masterdata.tokens.js';
export {
  type MasterdataLookup,
  type MaterialRef,
  type AliasRef,
  MASTERDATA_LOOKUP,
  materialMatchKey,
} from './public-api.js';
export { isTotalRow, materialNameKey, MATERIAL_NAME_KEY_TEXT, HAZARD_CLASSES } from './material/material-names.js';
/* IMPORT-RP: the bulk imports (api/src/imports) write each row through the same services the
 * single-record routes call, bound to the import's transaction (as PROD-B does with GrnService). */
export { MaterialService } from './material/material.service.js';
export { DilutionService, judgeShares, microText } from './material/dilution.service.js';
export { masterdataSchema } from './cluster-masterdata.tokens.js';
export type { CreateMaterial, CreateMaterialDilution } from './cluster-masterdata.dtos.js';
