/**
 * iam schema barrel (Phase-1A foundation). drizzle.config points here.
 */
export { iam } from "./_schema.js";
export {
  orgGroupMaster,
  orgTypeMaster,
  orgMaster,
  orgRelationship,
  businessUnitMaster,
} from "./org.js";
export { userMaster } from "./users.js";
export { assertionJti } from "./assertion-jti.js";
export { approvalMatrix } from "./policy.js";
export {
  roleMaster,
  permissionMaster,
  rolePermissionMapping,
  userRoleMapping,
  vaultRoleGrantRequest,
  locationAuthorityMaster,
} from "./security.js";
