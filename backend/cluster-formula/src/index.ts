/**
 * @ra/cluster-formula — the formula vault module + its public port + DB token. The approval
 * flow emits formula.version.approved / formula.copy.approved via the transactional outbox
 * (in the Vault database; the main app box does not drain it). The ONLY recipe read surface is
 * the FORMULA_LOOKUP port (floor view = RM_ALIAS + % only; manufacturing instruction and the
 * production order's pick list = floor code + quantity only). The real recipe is sealed at rest
 * and never leaves un-decrypted or un-audited.
 */
export { FormulaModule, isVaultMode } from './formula.module.js';
export { FORMULA_DB, FORMULA_PG_CLIENT, type FormulaDb } from './formula.tokens.js';
export { formulaEvents } from './formula.events.js';
export {
  type CodedInstruction,
  type CodedMaterialLine,
  type CodedPickLine,
  type FloorIngredient,
  type FormulaLookup,
  type ReadContext,
  FORMULA_LOOKUP,
} from './public-api.js';
export { PICK_QUANTITY_SCALE, instructionQuantity, pickLineRequiredQty } from './pick-quantity.js';
export { materialRef, materialRefKey } from './material-ref.js';
// Non-recipe reads the main box's screens make over the signed channel (codes/statuses, never a
// formula name), and the material catalogue the main box pushes to the Vault's picker.
export {
  FormulaDirectoryService,
  accessAuditBounds,
  type AccessAuditPage,
  type AccessAuditRow,
  type FormulaDirectoryEntry,
  type FormulaDirectoryPage,
  type FormulaLabel,
  type FormulaLabels,
  type FormulaLabelsQuery,
  type FormulaVersionLabel,
} from './formula-directory.service.js';
export {
  MaterialCatalogue,
  MATERIAL_CATALOGUE_PART_SIZE,
  catalogueParts,
  materialCatalogueDigest,
  type CatalogueUpdate,
  type MaterialCatalogueEntry,
} from './facts-bridge/material-catalogue.js';
// Owner ruling 2026-09-28: raw-material compliance data + the IFRA/allergen certificate engine
// (Vault box only), and the certificate shape the main box pulls over the signed channel.
export { ComplianceService, type InternalCertificate } from './compliance/compliance.service.js';
// Always-on Ruh on the Vault box: the bulk-approval warning, the override log the main box pulls
// (counts and the typed reason only), and the Vault's counts for Ruh's insights.
export {
  RuhVaultService,
  RUH_VAULT_BULK_ACTION,
  type VaultRisk,
  type VaultRuhCounts,
  type VaultRuhOverride,
} from './setup/ruh-vault.service.js';
export {
  IFRA_CATEGORIES,
  calculateAllergens,
  calculateIfra,
  type AllergenValue,
  type IfraValue,
} from './compliance/compliance-calc.js';
// The main-app-box side of the Vault trust boundary (V4 §109.1): the signed HTTP client, the
// production-facing port it backs, and the remote audit sink — the main box reaches the Vault over
// the signed internal channel only and never holds a formula-DB connection. See vault-port.ts.
export {
  VAULT_PORT,
  VAULT_INTERNAL_PATHS,
  VAULT_PRINCIPAL_PATHS,
  type PickLine,
  type VaultPort,
  VaultApiClient,
  VaultPortModule,
  VaultSecurityAuditClient,
} from './vault-port.js';
// Lane vaultsetup (owner decisions 2026-10-05): formula shells per factory product, the recipe
// import, the review queue and the one-person bulk approval (Vault box only), plus the shapes the
// main box's setup screen reads back.
export {
  FormulaSetupService,
  shellFormulaCode,
  type ShellResult,
  type ShellState,
  type ShellView,
  type ImportResult,
  type ReviewItem,
  type BatchApprovalResult,
} from './setup/formula-setup.service.js';
export { parseRecipeFile, parsePercent, detectDelimiter, totalPercent, isHundred, type RecipeLine } from './setup/recipe-csv.js';
export { SHELL_KINDS, type ShellKind, type FormulaShellsBody } from './formula.dtos.js';
