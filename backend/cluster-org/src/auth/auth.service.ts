/**
 * AuthService — login against the dictionary USER_MASTER (Phase-1A). Verifies the Argon2id
 * password_hash, flattens the user's roles (USER_ROLE_MAPPING → ROLE_MASTER) and permissions
 * (→ ROLE_PERMISSION_MAPPING → PERMISSION_MASTER) and mints the access/refresh tokens the
 * @core edge guards already consume. `setPassword` hashes + stores a user's password.
 *
 * MVP note: no server-side session store yet (the dictionary has no sessions table), so
 * refresh is stateless re-mint without reuse-detection — a hardening follow-up.
 */
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import * as argon2 from "argon2";
import { DomainError, JwtService, type AuthPrincipal } from "@core/backend-kernel";
import type { Portal } from "@core/contracts";
import { ORG_DB, orgSchema, type OrgDb } from "../cluster-org.tokens.js";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
};

// RA is a single manufacturing tenant; the access-token audience is fixed for now.
const RA_PORTAL: Portal = "owner";

export interface LoginResult {
  user: { userId: string; userName: string | null; email: string | null };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(ORG_DB) private readonly db: OrgDb,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  /** Password login against user_master (identifier = email). */
  async login(identifier: string, password: string): Promise<LoginResult> {
    const { userMaster } = orgSchema;
    const row = (
      await this.db
        .select({
          userId: userMaster.userId,
          userName: userMaster.userName,
          email: userMaster.email,
          passwordHash: userMaster.passwordHash,
          isActive: userMaster.isActive,
        })
        .from(userMaster)
        .where(eq(userMaster.email, identifier))
        .limit(1)
    )[0];
    if (!row || !row.passwordHash) {
      throw DomainError.unauthorized("AUTH_INVALID_CREDENTIALS", "Invalid credentials");
    }
    const ok = await argon2.verify(row.passwordHash, password);
    if (!ok) {
      throw DomainError.unauthorized("AUTH_INVALID_CREDENTIALS", "Invalid credentials");
    }
    if (row.isActive === false) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", "Account inactive");
    }

    const roles = await this.rolesFor(row.userId);
    const perms = await this.permissionsFor(row.userId);
    const accessToken = await this.jwt.signAccess({
      sub: row.userId,
      portal: RA_PORTAL,
      roles,
      perms,
      pv: 1,
      sid: row.userId,
    });
    const refreshToken = await this.jwt.signRefresh({ sub: row.userId, sid: row.userId });
    return {
      user: { userId: row.userId, userName: row.userName, email: row.email },
      accessToken,
      refreshToken,
      expiresIn: this.jwt.accessTtlSeconds,
    };
  }

  /** Stateless refresh — verify the refresh token, re-load roles/perms, re-mint the access token
   * (so the portal survives a reload / 15-min access-token expiry). No reuse-detection yet (MVP). */
  async refresh(refreshToken: string): Promise<LoginResult> {
    let claims: { sub: string };
    try {
      claims = await this.jwt.verifyRefresh(refreshToken);
    } catch {
      throw DomainError.unauthorized("AUTH_TOKEN_INVALID", "Invalid or expired refresh token");
    }
    const { userMaster } = orgSchema;
    const row = (
      await this.db
        .select({
          userId: userMaster.userId,
          userName: userMaster.userName,
          email: userMaster.email,
          isActive: userMaster.isActive,
        })
        .from(userMaster)
        .where(eq(userMaster.userId, claims.sub))
        .limit(1)
    )[0];
    if (!row) throw DomainError.unauthorized("AUTH_TOKEN_INVALID", "User not found");
    if (row.isActive === false) throw DomainError.forbidden("AUTH_FORBIDDEN", "Account inactive");
    const roles = await this.rolesFor(row.userId);
    const perms = await this.permissionsFor(row.userId);
    const accessToken = await this.jwt.signAccess({
      sub: row.userId,
      portal: RA_PORTAL,
      roles,
      perms,
      pv: 1,
      sid: row.userId,
    });
    const newRefresh = await this.jwt.signRefresh({ sub: row.userId, sid: row.userId });
    return {
      user: { userId: row.userId, userName: row.userName, email: row.email },
      accessToken,
      refreshToken: newRefresh,
      expiresIn: this.jwt.accessTtlSeconds,
    };
  }

  /** Hash + store a user's password (admin-gated). */
  async setPassword(userId: string, password: string): Promise<{ userId: string }> {
    const { userMaster } = orgSchema;
    const exists = (
      await this.db
        .select({ userId: userMaster.userId })
        .from(userMaster)
        .where(eq(userMaster.userId, userId))
        .limit(1)
    )[0];
    if (!exists) throw DomainError.notFound("User not found");
    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
    await this.db
      .update(userMaster)
      .set({ passwordHash, updatedBy: userId })
      .where(eq(userMaster.userId, userId));
    return { userId };
  }

  /** Current user's profile. */
  async me(principal: AuthPrincipal): Promise<{
    userId: string;
    userName: string | null;
    email: string | null;
    roles: string[];
    permissions: string[];
  }> {
    const { userMaster } = orgSchema;
    const row = (
      await this.db
        .select({
          userId: userMaster.userId,
          userName: userMaster.userName,
          email: userMaster.email,
        })
        .from(userMaster)
        .where(eq(userMaster.userId, principal.userId))
        .limit(1)
    )[0];
    if (!row) throw DomainError.notFound("User not found");
    return {
      userId: row.userId,
      userName: row.userName,
      email: row.email,
      roles: await this.rolesFor(row.userId),
      permissions: await this.permissionsFor(row.userId),
    };
  }

  private async rolesFor(userId: string): Promise<string[]> {
    const { userRoleMapping, roleMaster } = orgSchema;
    const rows = await this.db
      .select({ code: roleMaster.roleCode })
      .from(userRoleMapping)
      .innerJoin(roleMaster, eq(roleMaster.roleId, userRoleMapping.roleId))
      .where(eq(userRoleMapping.userId, userId));
    return rows.map((r) => r.code).filter((c): c is string => c !== null);
  }

  private async permissionsFor(userId: string): Promise<string[]> {
    const { userRoleMapping, rolePermissionMapping, permissionMaster } = orgSchema;
    const rows = await this.db
      .selectDistinct({ code: permissionMaster.permissionCode })
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
    return rows.map((r) => r.code).filter((c): c is string => c !== null);
  }
}
