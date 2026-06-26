/**
 * SecurityService — CRUD over the user + RBAC tables (user, role, permission,
 * role↔permission, user↔role, location authority). Same foundation-master shape as
 * OrgService: create stamps created_by/updated_by + status "ACTIVE"; list is cursor
 * paginated (desc PK, limit+1). `passwordHash` is taken as-is for now (auth service later).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { ORG_DB, orgSchema, type OrgDb } from '../cluster-org.tokens.js';
import type { ListQuery, Page } from '../cluster-org.dtos.js';
import type {
  CreateLocationAuthorityBody,
  CreatePermissionBody,
  CreateRoleBody,
  CreateRolePermissionBody,
  CreateUserBody,
  CreateUserRoleBody,
} from './security.dtos.js';

const {
  userMaster,
  roleMaster,
  permissionMaster,
  rolePermissionMapping,
  userRoleMapping,
  locationAuthorityMaster,
} = orgSchema;

type UserRow = typeof userMaster.$inferSelect;
/** A user row WITHOUT the password hash — never send the secret over the wire, even encrypted. */
type SafeUser = Omit<UserRow, 'passwordHash'>;
const USER_SAFE = {
  userId: userMaster.userId,
  organizationId: userMaster.organizationId,
  employeeCode: userMaster.employeeCode,
  userName: userMaster.userName,
  email: userMaster.email,
  mobileNumber: userMaster.mobileNumber,
  isActive: userMaster.isActive,
  status: userMaster.status,
  createdDt: userMaster.createdDt,
  updatedDt: userMaster.updatedDt,
  createdBy: userMaster.createdBy,
  updatedBy: userMaster.updatedBy,
} as const;
type RoleRow = typeof roleMaster.$inferSelect;
type PermissionRow = typeof permissionMaster.$inferSelect;
type RolePermissionRow = typeof rolePermissionMapping.$inferSelect;
type UserRoleRow = typeof userRoleMapping.$inferSelect;
type LocationAuthorityRow = typeof locationAuthorityMaster.$inferSelect;

@Injectable()
export class SecurityService {
  constructor(@Inject(ORG_DB) private readonly db: OrgDb) {}

  // ── user_master ───────────────────────────────────────────────────────────
  async createUser(body: CreateUserBody, principal: AuthPrincipal): Promise<SafeUser> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(userMaster)
      .values({
        organizationId: body.organizationId,
        employeeCode: body.employeeCode,
        userName: body.userName,
        email: body.email,
        mobileNumber: body.mobileNumber,
        passwordHash: body.passwordHash,
        isActive: body.isActive ?? true,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning(USER_SAFE);
    return ensure(rows[0]);
  }

  async listUsers(query: ListQuery): Promise<Page<SafeUser>> {
    const rows = await this.db
      .select(USER_SAFE)
      .from(userMaster)
      .where(query.cursor ? lt(userMaster.userId, query.cursor) : undefined)
      .orderBy(desc(userMaster.userId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.userId);
  }

  async getUserById(id: string): Promise<SafeUser | null> {
    const rows = await this.db
      .select(USER_SAFE)
      .from(userMaster)
      .where(eq(userMaster.userId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── role_master ───────────────────────────────────────────────────────────
  async createRole(body: CreateRoleBody, principal: AuthPrincipal): Promise<RoleRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(roleMaster)
      .values({
        roleCode: body.roleCode,
        roleName: body.roleName,
        description: body.description,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listRoles(query: ListQuery): Promise<Page<RoleRow>> {
    const rows = await this.db
      .select()
      .from(roleMaster)
      .where(query.cursor ? lt(roleMaster.roleId, query.cursor) : undefined)
      .orderBy(desc(roleMaster.roleId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.roleId);
  }

  async getRoleById(id: string): Promise<RoleRow | null> {
    const rows = await this.db
      .select()
      .from(roleMaster)
      .where(eq(roleMaster.roleId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── permission_master ─────────────────────────────────────────────────────
  async createPermission(
    body: CreatePermissionBody,
    principal: AuthPrincipal,
  ): Promise<PermissionRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(permissionMaster)
      .values({
        permissionCode: body.permissionCode,
        permissionName: body.permissionName,
        moduleName: body.moduleName,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listPermissions(query: ListQuery): Promise<Page<PermissionRow>> {
    const rows = await this.db
      .select()
      .from(permissionMaster)
      .where(query.cursor ? lt(permissionMaster.permissionId, query.cursor) : undefined)
      .orderBy(desc(permissionMaster.permissionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.permissionId);
  }

  async getPermissionById(id: string): Promise<PermissionRow | null> {
    const rows = await this.db
      .select()
      .from(permissionMaster)
      .where(eq(permissionMaster.permissionId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── role_permission_mapping ───────────────────────────────────────────────
  async createRolePermission(
    body: CreateRolePermissionBody,
    principal: AuthPrincipal,
  ): Promise<RolePermissionRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(rolePermissionMapping)
      .values({
        roleId: body.roleId,
        permissionId: body.permissionId,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listRolePermissions(query: ListQuery): Promise<Page<RolePermissionRow>> {
    const rows = await this.db
      .select()
      .from(rolePermissionMapping)
      .where(
        query.cursor
          ? lt(rolePermissionMapping.rolePermissionMappingId, query.cursor)
          : undefined,
      )
      .orderBy(desc(rolePermissionMapping.rolePermissionMappingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rolePermissionMappingId);
  }

  async getRolePermissionById(id: string): Promise<RolePermissionRow | null> {
    const rows = await this.db
      .select()
      .from(rolePermissionMapping)
      .where(eq(rolePermissionMapping.rolePermissionMappingId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── user_role_mapping ─────────────────────────────────────────────────────
  async createUserRole(
    body: CreateUserRoleBody,
    principal: AuthPrincipal,
  ): Promise<UserRoleRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(userRoleMapping)
      .values({
        userId: body.userId,
        roleId: body.roleId,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listUserRoles(query: ListQuery): Promise<Page<UserRoleRow>> {
    const rows = await this.db
      .select()
      .from(userRoleMapping)
      .where(
        query.cursor ? lt(userRoleMapping.userRoleMappingId, query.cursor) : undefined,
      )
      .orderBy(desc(userRoleMapping.userRoleMappingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.userRoleMappingId);
  }

  async getUserRoleById(id: string): Promise<UserRoleRow | null> {
    const rows = await this.db
      .select()
      .from(userRoleMapping)
      .where(eq(userRoleMapping.userRoleMappingId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── location_authority_master ─────────────────────────────────────────────
  async createLocationAuthority(
    body: CreateLocationAuthorityBody,
    principal: AuthPrincipal,
  ): Promise<LocationAuthorityRow> {
    const actor = principal.userId;
    const rows = await this.db
      .insert(locationAuthorityMaster)
      .values({
        locationId: body.locationId,
        authorityUserId: body.authorityUserId,
        authorityRoleId: body.authorityRoleId,
        authorityType: body.authorityType,
        effectiveFromDt: body.effectiveFromDt ? new Date(body.effectiveFromDt) : undefined,
        effectiveToDt: body.effectiveToDt ? new Date(body.effectiveToDt) : undefined,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return ensure(rows[0]);
  }

  async listLocationAuthorities(query: ListQuery): Promise<Page<LocationAuthorityRow>> {
    const rows = await this.db
      .select()
      .from(locationAuthorityMaster)
      .where(
        query.cursor
          ? lt(locationAuthorityMaster.locationAuthorityId, query.cursor)
          : undefined,
      )
      .orderBy(desc(locationAuthorityMaster.locationAuthorityId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.locationAuthorityId);
  }

  async getLocationAuthorityById(id: string): Promise<LocationAuthorityRow | null> {
    const rows = await this.db
      .select()
      .from(locationAuthorityMaster)
      .where(eq(locationAuthorityMaster.locationAuthorityId, id))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** Slice the `limit+1` window into a page + the next cursor (the last kept row's id). */
function paginate<T>(rows: T[], limit: number, idOf: (row: T) => string): Page<T> {
  const items = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit && items.length > 0 ? idOf(items[items.length - 1]!) : null;
  return { items, nextCursor };
}

/** Guard an INSERT … RETURNING result that the type system marks optional. */
function ensure<T>(row: T | undefined): T {
  if (!row) throw new Error('insert returned no row');
  return row;
}
