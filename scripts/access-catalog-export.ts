// Prints, as one JSON object on stdout, every fact ALEMBIC's
// ops/scripts/access-catalog.mjs (PB-05/SB-03/PB-13, V4 §102-§104/§112-§114)
// needs from this repository's own role/permission source of truth
// (scripts/ra-roles.ts + scripts/ra-permissions.ts) to build the shared
// release/access/*.json catalogs.
//
// WHY A SEPARATE SCRIPT RATHER THAN ALEMBIC IMPORTING ra-roles.ts DIRECTLY.
// `RoleDef.select` is a PREDICATE FUNCTION (`(permissionCode) => boolean`),
// the same shape scripts/db-seed.ts already runs to build role_permission_
// mapping rows. A static reader of the source text cannot evaluate an
// arbitrary predicate without re-implementing it, and re-implementing it is
// exactly the kind of second copy that drifts from the one the seed actually
// runs. Executing it here, in THIS repository, with THIS repository's own
// tsx, is the only way the computed permission set is guaranteed to be the
// same one scripts/db-seed.ts grants for real.
//
// ALEMBIC's ops/scripts/access-catalog.mjs runs this via
// `pnpm exec tsx scripts/access-catalog-export.ts` in $RAWPROD_DIR and reads
// stdout. When RAWPROD_DIR is unset (ALEMBIC CI does not check RawProd out),
// the generator falls back to the snapshot this script's own output was used
// to write: release/access/.rawprod-snapshot.json, committed in ALEMBIC.
//
//   npx tsx scripts/access-catalog-export.ts
//
import {
  ROLES,
  VAULT_PLAINTEXT_PERMISSION,
  VAULT_PLAINTEXT_ROLES,
  PLATFORM_OPS_PERMISSION,
  PLATFORM_OPS_ROLES,
  ROLE_GRANT_PERMISSION,
  ROLE_GRANTERS,
  FORMULA_DECISION_PERMISSIONS,
  FORMULATOR_FORBIDDEN_PERMISSIONS,
  VAULT_APPROVER_FORBIDDEN_PERMISSIONS,
  MANUFACTURING_INSTRUCTION_PERMISSION,
  MANUFACTURING_INSTRUCTION_ROLES,
  CAPABILITY_PERMISSIONS,
} from './ra-roles.js';
import { RA_PERMISSIONS } from './ra-permissions.js';

const ALL_PERMISSIONS = [...RA_PERMISSIONS, ...CAPABILITY_PERMISSIONS];

const roles = ROLES.map((role) => ({
  code: role.code,
  name: role.name,
  view: role.view,
  permissions: ALL_PERMISSIONS.filter((p) => role.select(p)).sort(),
}));

const out = {
  generatedAt: new Date().toISOString(),
  source: 'scripts/access-catalog-export.ts',
  permissions: [...RA_PERMISSIONS].sort(),
  capabilityPermissions: [...CAPABILITY_PERMISSIONS].sort(),
  roles,
  vaultPlaintextPermission: VAULT_PLAINTEXT_PERMISSION,
  vaultPlaintextRoles: [...VAULT_PLAINTEXT_ROLES].sort(),
  platformOpsPermission: PLATFORM_OPS_PERMISSION,
  platformOpsRoles: [...PLATFORM_OPS_ROLES].sort(),
  roleGrantPermission: ROLE_GRANT_PERMISSION,
  roleGranters: [...ROLE_GRANTERS].sort(),
  formulaDecisionPermissions: [...FORMULA_DECISION_PERMISSIONS].sort(),
  formulatorForbiddenPermissions: [...FORMULATOR_FORBIDDEN_PERMISSIONS].sort(),
  vaultApproverForbiddenPermissions: [...VAULT_APPROVER_FORBIDDEN_PERMISSIONS].sort(),
  manufacturingInstructionPermission: MANUFACTURING_INSTRUCTION_PERMISSION,
  manufacturingInstructionRoles: [...MANUFACTURING_INSTRUCTION_ROLES].sort(),
};

process.stdout.write(JSON.stringify(out));
