/**
 * @ra/cluster-org — the RAW AROMACHEM org cluster module + its public port.
 *
 * Exports the module (composed by `api`), the `ORG_DB` token (for a worker, though this
 * foundation cluster has no outbox), the `ORG_LOOKUP` cold-read port + its types, and
 * `OrgService` (the concrete class — see cluster-org.module.ts's doc comment for why
 * `backend/api/src/platform-ops` reuses it directly rather than duplicating `listOrgs`).
 */
export { ClusterOrgModule } from './cluster-org.module.js';
export { ORG_DB, type OrgDb } from './cluster-org.tokens.js';
export { OrgService } from './org/org.service.js';
export {
  type OrgLookup,
  type OrgRef,
  type OrgUserRef,
  ORG_LOOKUP,
} from './public-api.js';
