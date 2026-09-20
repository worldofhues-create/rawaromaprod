/**
 * OrgLookupService — in-cluster implementation of the `OrgLookup` public port.
 * Provided under `ORG_LOOKUP` so consumers depend only on the interface. Permission
 * resolution joins user_role_mapping → role_permission_mapping → permission_master.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ORG_DB, orgSchema, type OrgDb } from './cluster-org.tokens.js';
import type { OrgLookup, OrgRef, OrgUserRef } from './public-api.js';

const {
  userMaster,
  orgMaster,
  userRoleMapping,
  rolePermissionMapping,
  permissionMaster,
} = orgSchema;

@Injectable()
export class OrgLookupService implements OrgLookup {
  constructor(@Inject(ORG_DB) private readonly db: OrgDb) {}

  async findUser(userId: string): Promise<OrgUserRef | null> {
    const row = (
      await this.db
        .select({
          userId: userMaster.userId,
          email: userMaster.email,
          userName: userMaster.userName,
          organizationId: userMaster.organizationId,
        })
        .from(userMaster)
        .where(eq(userMaster.userId, userId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findOrg(orgId: string): Promise<OrgRef | null> {
    const row = (
      await this.db
        .select({
          organizationId: orgMaster.organizationId,
          organizationCode: orgMaster.organizationCode,
          organizationName: orgMaster.organizationName,
        })
        .from(orgMaster)
        .where(eq(orgMaster.organizationId, orgId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async getUserRoleIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ roleId: userRoleMapping.roleId })
      .from(userRoleMapping)
      .where(eq(userRoleMapping.userId, userId));
    const ids: string[] = [];
    for (const r of rows) {
      if (r.roleId) ids.push(r.roleId);
    }
    return ids;
  }

  async getUserPermissionCodes(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ permissionCode: permissionMaster.permissionCode })
      .from(userRoleMapping)
      .innerJoin(
        rolePermissionMapping,
        eq(rolePermissionMapping.roleId, userRoleMapping.roleId),
      )
      .innerJoin(
        permissionMaster,
        eq(permissionMaster.permissionId, rolePermissionMapping.permissionId),
      )
      .where(eq(userRoleMapping.userId, userId));

    const codes = new Set<string>();
    for (const r of rows) {
      if (r.permissionCode) codes.add(r.permissionCode);
    }
    return [...codes];
  }
}
