/**
 * @ra/cluster-formula — the formula vault module + its public port + DB token. The approval
 * flow emits formula.version.approved / formula.copy.approved via the transactional outbox;
 * the worker drains that outbox onto the bus for production. The ONLY recipe read surface is
 * the FORMULA_LOOKUP port (floor view = RM_ALIAS + % only; pick list server-side only). The
 * real recipe is sealed at rest and never leaves un-decrypted or un-audited.
 */
export { FormulaModule, isVaultMode } from './formula.module.js';
export { FORMULA_DB, FORMULA_PG_CLIENT, type FormulaDb } from './formula.tokens.js';
export { formulaEvents } from './formula.events.js';
export {
  type CodedInstruction,
  type FloorIngredient,
  type FormulaLookup,
  type PickIngredient,
  type ReadContext,
  FORMULA_LOOKUP,
} from './public-api.js';
// PB-03 remainder — the main-app-box side of the Vault trust boundary (V4 §109.1): a narrow
// port + its remote-HTTP binding, so ProductionModule reaches the Vault over the signed
// internal channel instead of importing FormulaModule's own DB-backed FORMULA_LOOKUP for
// coded-instruction resolution. See vault-port.ts's header for the full design.
export {
  VAULT_PORT,
  type VaultPort,
  VaultPortHttpClient,
  VaultPortModule,
} from './vault-port.js';
