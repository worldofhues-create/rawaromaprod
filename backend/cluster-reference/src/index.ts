/**
 * @ra/cluster-reference — the reference cluster module + its public port + DB token.
 * Foundation config: no outbox/worker wiring (the token is exported for symmetry with the
 * event-emitting clusters).
 */
export { ReferenceModule } from './reference.module.js';
export { REFERENCE_DB, type ReferenceDb } from './reference.tokens.js';
export {
  type BrandRef,
  type CountryRef,
  type CurrencyRef,
  type DocumentRef,
  type ReferenceLookup,
  type UomRef,
  REFERENCE_LOOKUP,
} from './public-api.js';
