/**
 * SecurityService — CRUD over the user + RBAC tables (user, role, permission,
 * role↔permission, user↔role, location authority). Same foundation-master shape as
 * OrgService: create stamps created_by/updated_by + status "ACTIVE"; list is cursor
 * paginated (desc PK, limit+1). `passwordHash` is taken as-is for now (auth service later).
 */
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import * as argon2 from 'argon2';
import {
  DomainError,
  SECURITY_AUDIT_SINK,
  type AuthPrincipal,
  type SecurityAuditSink,
} from '@core/backend-kernel';

// Same Argon2id parameters the auth service uses to hash/verify passwords.
const ARGON2_OPTIONS: argon2.Options = { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 };
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
  vaultRoleGrantRequest,
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
  // S3 security review item 1 — visible (never editable through the generic path; see
  // edit.service.ts) so an admin screen can show whether a row is bound to an ALEMBIC
  // identity, without exposing anything secret (it is an identity label, not a credential).
  alembicSubject: userMaster.alembicSubject,
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
type VaultRoleGrantRequestRow = typeof vaultRoleGrantRequest.$inferSelect;
type LocationAuthorityRow = typeof locationAuthorityMaster.$inferSelect;

/**
 * Permission-code predicates that are NEVER runtime-grantable to a role outside a HARD,
 * code-level allow-list — regardless of what the caller who's granting already holds
 * (security review item 1). Without this, anyone holding the ordinary
 * `iam:role_permission_mapping:write` permission (e.g. `admin`) could POST
 * /v1/role-permissions and hand `owner` (or any role) `formula:actual:read`,
 * `vault:material_search:read`, `formula:formula_approval:write`,
 * `formula:formula_access_policy:write`, or `platformops:console:read` — a one-request
 * privilege escalation completely outside the go-live seed (scripts/ra-roles.ts) that fixes
 * these grants. These assignments never change at runtime; only a code change + re-seed can.
 */
const VAULT_FORMULA_SENSITIVE = (code: string): boolean =>
  code.startsWith('vault:') ||
  code.startsWith('formula:actual:') ||
  code === 'formula:formula_approval:write' ||
  code === 'formula:formula_access_policy:write';

const VAULT_FORMULA_ALLOWED_ROLES = ['formulator', 'vault_approver'];

const PLATFORMOPS_SENSITIVE = (code: string): boolean => code.startsWith('platformops:');
const PLATFORMOPS_ALLOWED_ROLES = ['platform_super_admin'];

/** Target roles for user_role_mapping that get an explicit allow-list EXCEPTION to the
 * ordinary "you can only grant a subset of your own permissions" rule (security review
 * item 6) — see createUserRole. `owner`/`admin` never hold vault:* / formula:actual:read
 * themselves (§107 "god-mode stops at the vault door"), so the ordinary subset check makes
 * these two roles permanently unassignable by anyone; without this exception there would be
 * NO working path to ever create a formulator or vault_approver user. */
const VAULT_AUTHORITY_ROLES = ['formulator', 'vault_approver'];

/** How long a PENDING vault-role grant request stays approvable before it must be re-requested
 * (S2 security review item A). */
const VAULT_GRANT_TTL_HOURS = 72;

const OWNER_ADMIN = ['owner', 'admin'];

/**
 * OPERATIONAL NOTE — single-admin tenants: approveVaultRoleGrant requires an owner/admin who is
 * NOT the requester, NOT the target, and NOT an account the requester created. A tenant with
 * only ONE owner/admin account therefore has NO WAY to ever assign formulator/vault_approver —
 * by design, not a bug to route around. This is deliberate (a lone admin approving their own
 * Vault-authority grant, even via a fresh puppet account, is exactly the escalation this control
 * exists to stop) and there is NO bypass, override, or "break-glass" path in this service. A
 * tenant that needs a formulator/vault_approver must first provision a genuinely independent
 * second owner/admin account (a human RAC/tenant decision, not something this code should paper
 * over) — document this requirement wherever tenant onboarding is described.
 */

@Injectable()
export class SecurityService {
  constructor(
    @Inject(ORG_DB) private readonly db: OrgDb,
    @Optional() @Inject(SECURITY_AUDIT_SINK) private readonly auditSink?: SecurityAuditSink,
  ) {}

  // ── user_master ───────────────────────────────────────────────────────────
  async createUser(body: CreateUserBody, principal: AuthPrincipal): Promise<SafeUser> {
    const actor = principal.userId;
    // Hash a plaintext password server-side (the browser can't produce Argon2id), else take the
    // pre-computed hash. The DTO guarantees one of the two is present.
    const passwordHash = body.password ? await argon2.hash(body.password, ARGON2_OPTIONS) : body.passwordHash;
    const rows = await this.db
      .insert(userMaster)
      .values({
        organizationId: body.organizationId,
        employeeCode: body.employeeCode,
        userName: body.userName,
        email: body.email,
        mobileNumber: body.mobileNumber,
        passwordHash,
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

  /**
   * S4 security review finding N2 — true for `userId` if it currently holds a LIVE (not yet
   * decided, not yet expired) PENDING `vault_role_grant_request`. An account mid-grant for a
   * Vault-authority role is exactly the account an attacker most wants to control the moment
   * before the grant lands — either by re-pointing its email (`changeUserEmail`, below) or by
   * being the first to bind an ALEMBIC identity to it (`AuthService.loginWithAssertion`'s
   * first-bind branch, the sibling check for the same finding). Lazily treats a PENDING row
   * past its own `expiresDt` as already expired, the same way `approveVaultRoleGrant`'s own
   * pre-pass does, rather than requiring every caller to know about the sweep — this is a
   * read-only guard, not the sweep itself, so a stale PENDING row here simply reads as "no
   * live request" instead of being written to EXPIRED.
   */
  private async hasPendingVaultRoleGrant(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: vaultRoleGrantRequest.vaultRoleGrantRequestId })
      .from(vaultRoleGrantRequest)
      .where(and(
        eq(vaultRoleGrantRequest.userId, userId),
        eq(vaultRoleGrantRequest.grantStatus, 'PENDING'),
        gt(vaultRoleGrantRequest.expiresDt, new Date()),
      ))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * S3 security review item 1 — the DEDICATED, AUDITED path for changing a user's email.
   * `EditService`'s generic PATCH (`edit.service.ts`) never lists `email` as an editable
   * column any more — this is the only way to change it. Refuses outright for a target
   * holding a Vault-authority role (formulator/vault_approver), OR ONE PENDING FOR ONE (S4
   * finding N2): those accounts are exactly the ones `AuthService.loginWithAssertion`'s old
   * email-only mapping made a takeover target for, and a rare, high-stakes edit like this is
   * safer refused outright than built out into a second two-person flow nobody will exercise
   * often enough to trust — the SAME judgement this file already made for a current holder,
   * extended to cover the account that is about to become one. An ordinary user's email may
   * still be corrected here, permission-gated the same as the generic editor was
   * (`iam:user_master:write`), and every attempt is written to the audit sink whether it
   * succeeds or is refused.
   *
   * S4 FINDING N2, THE RULE (documented here because this is the one place it is enforced):
   * every successful email change on this path CLEARS `alembic_subject` unconditionally. A
   * changed email is a changed identity as far as the ALEMBIC bridge is concerned — leaving
   * the old binding in place would let the row go on answering to a subject that was proved
   * against an email it no longer has, and forces the honest outcome instead: the very next
   * assertion login for this row re-binds from scratch (S3 item 1's first-bind path), the same
   * as it would for a brand-new account.
   */
  async changeUserEmail(userId: string, newEmail: string, principal: AuthPrincipal): Promise<SafeUser> {
    const target = await this.getUserById(userId);
    if (!target) throw DomainError.notFound(`User not found: ${userId}`);

    const vaultRoles = await this.db
      .select({ code: roleMaster.roleCode })
      .from(userRoleMapping)
      .innerJoin(roleMaster, eq(roleMaster.roleId, userRoleMapping.roleId))
      .where(and(eq(userRoleMapping.userId, userId), inArray(roleMaster.roleCode, VAULT_AUTHORITY_ROLES)));
    const pendingVaultGrant = vaultRoles.length === 0 && (await this.hasPendingVaultRoleGrant(userId));

    if (vaultRoles.length > 0 || pendingVaultGrant) {
      if (this.auditSink) {
        await this.auditSink
          .record({
            actorId: principal.userId,
            action: 'security.user_email.refused',
            entityType: 'user_master',
            entityId: userId,
            reason: vaultRoles.length > 0
              ? `refused email change for a Vault-authority role holder (${vaultRoles.map((r) => r.code).join(', ')})`
              : 'refused email change for a user with a pending Vault-authority role grant request',
            result: 'refuse',
          })
          .catch(() => {});
      }
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        vaultRoles.length > 0
          ? 'This account holds a Vault-authority role (formulator/vault_approver) — its email cannot be changed through this path. Contact the owner.'
          : 'This account has a pending Vault-authority role grant request — its email cannot be changed until that request is decided or expires. Contact the owner.',
      );
    }

    const email = newEmail.toLowerCase();
    const actor = principal.userId;
    const rows = await this.db
      .update(userMaster)
      // S4 finding N2: alembic_subject is cleared on every email change, unconditionally —
      // see this method's own doc for why a changed email must never keep an old binding.
      .set({ email, alembicSubject: null, updatedBy: actor })
      .where(eq(userMaster.userId, userId))
      .returning(USER_SAFE);
    const updated = ensure(rows[0]);

    if (this.auditSink) {
      await this.auditSink
        .record({
          actorId: actor,
          action: 'security.user_email.changed',
          entityType: 'user_master',
          entityId: userId,
          reason: `email changed from "${target.email ?? ''}" to "${email}"`
            + (target.alembicSubject ? ' — alembic_subject cleared, re-bind required on next ALEMBIC sign-in' : ''),
          result: 'allow',
        })
        .catch(() => {});
    }
    return updated;
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
  /**
   * Runtime role↔permission self-grant guard (security review item 1). This endpoint's own
   * gate is the ordinary `iam:role_permission_mapping:write` permission — held by `admin` —
   * but that permission was never meant to let its holder hand out Vault/formula-decision/
   * Platform-Ops authority to an arbitrary role. Refuse the mapping outright, regardless of
   * what the CALLER holds, unless the target role is on the matching hard allow-list; audit
   * every refusal (the attempt is itself security-relevant, same as a guard-layer 403).
   */
  async createRolePermission(
    body: CreateRolePermissionBody,
    principal: AuthPrincipal,
  ): Promise<RolePermissionRow> {
    const [role, perm] = await Promise.all([
      this.db.select({ code: roleMaster.roleCode }).from(roleMaster).where(eq(roleMaster.roleId, body.roleId)).limit(1),
      this.db
        .select({ code: permissionMaster.permissionCode })
        .from(permissionMaster)
        .where(eq(permissionMaster.permissionId, body.permissionId))
        .limit(1),
    ]);
    if (!role[0]) throw DomainError.notFound('Role not found');
    if (!perm[0]) throw DomainError.notFound('Permission not found');
    const roleCode = String(role[0].code ?? '').toLowerCase();
    const permCode = String(perm[0].code ?? '');

    /* §107 role separation: the decision permissions belong to vault_approver alone —
       mapping them onto formulator would let formulators approve each other's work. */
    const approverOnly = permCode === 'formula:formula_approval:write' ||
      permCode === 'formula:formula_access_policy:write';
    const violatesVaultFormula = VAULT_FORMULA_SENSITIVE(permCode) &&
      !(approverOnly ? roleCode === 'vault_approver' : VAULT_FORMULA_ALLOWED_ROLES.includes(roleCode));
    const violatesPlatformOps = PLATFORMOPS_SENSITIVE(permCode) && !PLATFORMOPS_ALLOWED_ROLES.includes(roleCode);
    if (violatesVaultFormula || violatesPlatformOps) {
      if (this.auditSink) {
        await this.auditSink
          .record({
            actorId: principal.userId,
            action: 'security.role_permission.refused',
            entityType: 'role_permission_mapping',
            entityId: null,
            reason: `refused mapping ${permCode} onto role "${role[0].code}"`,
            result: 'refuse',
          })
          .catch(() => {});
      }
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        `"${permCode}" may never be mapped onto role "${role[0].code}" at runtime — this grant is fixed by the go-live seed, not this endpoint.`,
      );
    }

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
  /**
   * Grant a role to a user — OR, for a Vault-authority role (formulator/vault_approver),
   * open a PENDING two-person grant request instead (S2 security review item A). Returns a
   * `UserRoleRow` for the ordinary path, or a `VaultRoleGrantRequestRow` (status PENDING, no
   * effect on the target's permissions yet) for the vault-authority path — see
   * approveVaultRoleGrant for the second half.
   */
  async createUserRole(
    body: CreateUserRoleBody,
    principal: AuthPrincipal,
  ): Promise<UserRoleRow | VaultRoleGrantRequestRow> {
    // Privilege-escalation guard (audit H-S1): you may only grant a role whose permission set is a
    // SUBSET of your own, and never a top-level admin role unless you already hold it. Without this,
    // any admin (who holds iam:user_role_mapping:write) could self-grant `owner` → formula:actual:read.
    const role = (
      await this.db
        .select({ roleCode: roleMaster.roleCode })
        .from(roleMaster)
        .where(eq(roleMaster.roleId, body.roleId))
        .limit(1)
    )[0];
    if (!role) throw DomainError.notFound('Role not found');
    const targetCode = String(role.roleCode ?? '').toLowerCase();
    const granterRoles = (principal.roles ?? []).map((r) => r.toLowerCase());
    const PRIVILEGED = ['owner', 'super_admin', 'superadmin'];
    if (PRIVILEGED.includes(targetCode) && !granterRoles.includes(targetCode)) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', `You cannot grant the "${role.roleCode}" role.`);
    }

    const isVaultAuthorityRole = VAULT_AUTHORITY_ROLES.includes(targetCode);
    if (isVaultAuthorityRole) {
      // Explicit allow-list EXCEPTION to the subset rule below (security review item 6):
      // owner/admin never hold vault:*/formula:actual:read/formula-decision permissions
      // themselves (§107 — see also FORMULA_DECISION_PERMISSIONS in scripts/ra-roles.ts), so
      // the ordinary "you can only grant what you already hold" check can NEVER be satisfied
      // for formulator/vault_approver — without this exception these two roles would be
      // permanently unassignable to anyone. Restricted to owner/admin (the only roles ALSO
      // holding `iam:user_role_mapping:write`, scripts/ra-roles.ts ROLE_GRANTERS) and NEVER
      // to the granter themselves — a self-requesting owner/admin is exactly the runtime
      // privilege escalation §107 exists to prevent.
      if (!granterRoles.some((r) => OWNER_ADMIN.includes(r))) {
        throw DomainError.forbidden(
          'AUTH_FORBIDDEN',
          `Only owner/admin may request the "${role.roleCode}" role.`,
        );
      }
      if (body.userId === principal.userId) {
        throw DomainError.forbidden(
          'AUTH_FORBIDDEN',
          `You cannot assign yourself the "${role.roleCode}" role — self-assignment of a Vault-authority role is always refused, regardless of your own role.`,
        );
      }
      // security review item A: item 6's fix stopped a requester self-assigning a Vault-
      // authority role to THEIR OWN account, but left a second hole open — an owner/admin could
      // create a brand-new (puppet) user account and hand VAULT authority to that DIFFERENT
      // account instead, still with no second person involved. Closing that requires the
      // assignment to become a genuine two-person action: this call only opens a PENDING
      // request; a DIFFERENT owner/admin (checked in approveVaultRoleGrant, including that they
      // did not create the puppet account either) must approve it before it has any effect.
      return this.requestVaultRoleGrant(body, role.roleCode ?? targetCode, principal);
    }

    const rolePerms = (
      await this.db
        .select({ code: permissionMaster.permissionCode })
        .from(rolePermissionMapping)
        .innerJoin(
          permissionMaster,
          eq(permissionMaster.permissionId, rolePermissionMapping.permissionId),
        )
        .where(eq(rolePermissionMapping.roleId, body.roleId))
    ).map((r) => r.code);
    const held = new Set(principal.permissions ?? []);
    const missing = rolePerms.filter((p): p is string => !!p && !held.has(p));
    if (missing.length) {
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        `You cannot grant a role carrying permissions you do not hold (e.g. ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}).`,
      );
    }

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

  /**
   * Open a PENDING vault-role grant request (S2 item A). Never touches user_role_mapping — the
   * target's JWT permissions are completely unaffected until a different owner/admin approves.
   */
  private async requestVaultRoleGrant(
    body: CreateUserRoleBody,
    roleCode: string,
    principal: AuthPrincipal,
  ): Promise<VaultRoleGrantRequestRow> {
    const actor = principal.userId;
    const expiresDt = new Date(Date.now() + VAULT_GRANT_TTL_HOURS * 60 * 60 * 1000);
    const rows = await this.db
      .insert(vaultRoleGrantRequest)
      .values({
        userId: body.userId,
        roleId: body.roleId,
        grantStatus: 'PENDING',
        expiresDt,
        status: 'ACTIVE',
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    const inserted = ensure(rows[0]);
    if (this.auditSink) {
      await this.auditSink
        .record({
          actorId: actor,
          action: 'security.vault_role.requested',
          entityType: 'vault_role_grant_request',
          entityId: inserted.vaultRoleGrantRequestId,
          reason: `requested role "${roleCode}" for user ${body.userId} — pending a different owner/admin's approval`,
          result: 'allow',
        })
        .catch(() => {});
    }
    return inserted;
  }

  /**
   * S3 security review item 11 — walks the FULL `created_by` ancestor chain from `startUserId`
   * looking for `targetUserId`, not just one hop. The original puppet-account check only
   * compared `approver.createdBy === request.createdBy` — a requester who created account A,
   * who in turn created account B, could hand B to `approveVaultRoleGrant` and sail through:
   * `B.createdBy` is A's id, not the requester's, so the one-hop check never fired even though
   * B is transitively the requester's own puppet. `MAX_DEPTH` bounds the walk (both against a
   * pathological/cyclic `created_by` chain and as a plain sanity limit — real onboarding chains
   * are a handful of hops at most) and `visited` makes a cycle terminate rather than loop.
   */
  private async isInCreatorChain(startUserId: string, targetUserId: string): Promise<boolean> {
    const MAX_DEPTH = 12;
    // `created_by` is a free-text dictionary column (metaColumns' VARCHAR, not a uuid FK) —
    // most rows carry a real userId there, but a seed/system/legacy row can carry a sentinel
    // string like 'system' or 'test'. A non-uuid value can never itself be a user_master.
    // user_id (a real uuid column), so the walk simply ends there rather than issuing a query
    // Postgres would reject outright with an invalid-uuid-syntax error.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const lookupCreatedBy = async (id: string): Promise<string | null> => {
      const rows = await this.db.select({ createdBy: userMaster.createdBy }).from(userMaster)
        .where(eq(userMaster.userId, id)).limit(1);
      return rows[0]?.createdBy ?? null;
    };
    const visited = new Set<string>();
    let currentId: string | null = startUserId;
    for (let depth = 0; depth < MAX_DEPTH && currentId; depth++) {
      if (visited.has(currentId)) return false; // cycle — never resolves to targetUserId
      visited.add(currentId);
      if (!UUID_RE.test(currentId)) return false;
      const createdBy: string | null = await lookupCreatedBy(currentId);
      if (!createdBy) return false;
      if (createdBy === targetUserId) return true;
      currentId = createdBy;
    }
    return false;
  }

  /**
   * Approve a PENDING vault-role grant request (S2 item A) — the second person in the
   * two-person control. Only now does the mapping get inserted into user_role_mapping and take
   * effect; the approver must be a DIFFERENT owner/admin: not the requester, not the target
   * user, and not a puppet account the requester themselves created, directly OR transitively
   * (`user_master.created_by`, walked by `isInCreatorChain` — S3 item 11).
   *
   * S3 SECURITY REVIEW ITEM 9 — ATOMIC, ONE TRANSACTION. The original version read the request,
   * ran every check, inserted the mapping, and only THEN updated `grant_status` to APPROVED —
   * four round trips with no lock between the read and the write. Two concurrent approvals
   * (even by two genuinely different, individually-valid approvers) could both pass the
   * `grantStatus !== 'PENDING'` check before either had committed, producing two user_role_
   * mapping rows (caught only after the fact by the unique `(user_id, role_id)` index) or two
   * `security.vault_role.assigned` audit rows for one request. Now every read and write for one
   * decision happens inside a single `db.transaction`, the request row is locked
   * (`.for('update')`) before any check runs, and the actual state transition is the literal
   * `UPDATE ... WHERE grant_status = 'PENDING' RETURNING` this review item asks for — belt AND
   * braces on top of the row lock, so the invariant holds even if a future refactor ever drops
   * the lock.
   */
  async approveVaultRoleGrant(requestId: string, principal: AuthPrincipal): Promise<UserRoleRow> {
    // LAZY EXPIRY IS ITS OWN, IMMEDIATELY-COMMITTED STATEMENT — deliberately OUTSIDE the
    // transaction below. It must survive even though this whole approval attempt is about to
    // fail (a rollback of the main transaction would otherwise undo the EXPIRED mark too, since
    // both would be the same transaction); running it first, as an ordinary auto-committing
    // UPDATE, also avoids self-deadlocking against the `.for('update')` lock the main
    // transaction takes on the very same row a moment later.
    const preRow = (
      await this.db.select({ grantStatus: vaultRoleGrantRequest.grantStatus, expiresDt: vaultRoleGrantRequest.expiresDt, userId: vaultRoleGrantRequest.userId })
        .from(vaultRoleGrantRequest).where(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, requestId)).limit(1)
    )[0];
    if (preRow?.grantStatus === 'PENDING' && preRow.expiresDt && preRow.expiresDt.getTime() < Date.now()) {
      const expired = await this.db
        .update(vaultRoleGrantRequest)
        .set({ grantStatus: 'EXPIRED', updatedBy: 'system' })
        .where(and(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, requestId), eq(vaultRoleGrantRequest.grantStatus, 'PENDING')))
        .returning({ id: vaultRoleGrantRequest.vaultRoleGrantRequestId });
      if (expired.length > 0 && this.auditSink) {
        await this.auditSink
          .record({
            actorId: null,
            action: 'security.vault_role.expired',
            entityType: 'vault_role_grant_request',
            entityId: requestId,
            reason: `pending role request for user ${preRow.userId} expired unapproved after ${VAULT_GRANT_TTL_HOURS}h`,
            result: 'refuse',
          })
          .catch(() => {});
      }
    }

    return this.db.transaction(async (tx) => {
      const request = (
        await tx
          .select()
          .from(vaultRoleGrantRequest)
          .where(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, requestId))
          .for('update')
          .limit(1)
      )[0];
      if (!request) throw DomainError.notFound(`vault_role_grant_request not found: ${requestId}`);
      if (request.grantStatus !== 'PENDING') {
        // Covers the just-expired case too (grantStatus is now 'EXPIRED' from the pre-pass
        // above) with the same honest message every other already-decided state gets.
        throw DomainError.conflict(`This grant request is already ${request.grantStatus?.toLowerCase()}.`);
      }

      const approverRoles = (principal.roles ?? []).map((r) => r.toLowerCase());
      if (!approverRoles.some((r) => OWNER_ADMIN.includes(r))) {
        throw DomainError.forbidden('AUTH_FORBIDDEN', 'Only owner/admin may approve a Vault-authority role grant.');
      }
      if (principal.userId === request.createdBy) {
        throw DomainError.forbidden('AUTH_FORBIDDEN', 'You cannot approve your own Vault-authority role request — a different owner/admin must approve it.');
      }
      if (principal.userId === request.userId) {
        throw DomainError.forbidden('AUTH_FORBIDDEN', 'The user the role is being granted to cannot approve their own grant.');
      }
      // Puppet-account close, now transitive (S3 item 11): an approver anywhere in a chain of
      // accounts ultimately created by the requester is not a genuinely independent second
      // person — see the note in createUserRole.
      if (request.createdBy && (await this.isInCreatorChain(principal.userId, request.createdBy))) {
        throw DomainError.forbidden(
          'AUTH_FORBIDDEN',
          'You cannot approve this grant — your account was created by the same person who requested it (directly or through an intermediate account). A genuinely independent owner/admin must approve.',
        );
      }

      const role = (
        await tx
          .select({ roleCode: roleMaster.roleCode })
          .from(roleMaster)
          .where(eq(roleMaster.roleId, request.roleId!))
          .limit(1)
      )[0];

      const actor = principal.userId;

      // THE ATOMIC CLAIM (S3 item 9): every check above ran against the ROW LOCKED by
      // `.for('update')`, so nothing could have changed its status since — but the state
      // transition itself is still expressed as the conditional UPDATE this review item asks
      // for, not an unconditional one, so the invariant is enforced by the statement's own WHERE
      // clause and not only by the lock a future edit could accidentally drop.
      const claimed = await tx
        .update(vaultRoleGrantRequest)
        .set({ grantStatus: 'APPROVED', decidedBy: actor, decidedDt: new Date(), updatedBy: actor })
        .where(and(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, requestId), eq(vaultRoleGrantRequest.grantStatus, 'PENDING')))
        .returning();
      if (claimed.length === 0) {
        throw DomainError.conflict('This grant request was just decided by someone else — refresh and try again.');
      }

      // Unique (user_id, role_id) on user_role_mapping (packages/data-org/src/schema/
      // security.ts) is the final backstop against a duplicate role row even if this
      // transaction's own serialization were ever bypassed.
      const mappingRows = await tx
        .insert(userRoleMapping)
        .values({
          userId: request.userId,
          roleId: request.roleId,
          status: 'ACTIVE',
          createdBy: request.createdBy,
          updatedBy: actor,
        })
        .returning();
      const mapping = ensure(mappingRows[0]);

      await tx
        .update(vaultRoleGrantRequest)
        .set({ userRoleMappingId: mapping.userRoleMappingId, updatedBy: actor })
        .where(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, requestId));

      if (this.auditSink) {
        // Vault-authority role assignment is itself security-relevant enough to record on the
        // tamper-evident chain (security review item 6, extended by item A) — fires on ACTIVATION
        // (this approval), not on the initial request.
        await this.auditSink
          .record({
            actorId: actor,
            action: 'security.vault_role.assigned',
            entityType: 'user_role_mapping',
            entityId: mapping.userRoleMappingId,
            reason: `approved role "${role?.roleCode ?? request.roleId}" for user ${request.userId} (requested by ${request.createdBy})`,
            result: 'allow',
          })
          .catch(() => {
            // Never fail the (already-committed, already-authorized) assignment over an audit
            // write hiccup — same posture as the guard-layer sinks.
          });
      }
      return mapping;
    });
  }

  /**
   * Requester-initiated cancel of their own still-PENDING request (S2 item A). S3 security
   * review item 9: same atomic-transaction, locked-row, conditional-UPDATE shape as
   * `approveVaultRoleGrant` — a cancel racing an approve (or a second cancel) must not both
   * appear to succeed.
   */
  async cancelVaultRoleGrant(requestId: string, principal: AuthPrincipal): Promise<{ vaultRoleGrantRequestId: string }> {
    return this.db.transaction(async (tx) => {
      const request = (
        await tx
          .select()
          .from(vaultRoleGrantRequest)
          .where(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, requestId))
          .for('update')
          .limit(1)
      )[0];
      if (!request) throw DomainError.notFound(`vault_role_grant_request not found: ${requestId}`);
      if (request.createdBy !== principal.userId) {
        throw DomainError.forbidden('AUTH_FORBIDDEN', 'Only the requester may cancel this grant request.');
      }
      if (request.grantStatus !== 'PENDING') {
        throw DomainError.conflict(`This grant request is already ${request.grantStatus?.toLowerCase()}.`);
      }
      const actor = principal.userId;
      const claimed = await tx
        .update(vaultRoleGrantRequest)
        .set({ grantStatus: 'CANCELLED', decidedBy: actor, decidedDt: new Date(), updatedBy: actor })
        .where(and(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, requestId), eq(vaultRoleGrantRequest.grantStatus, 'PENDING')))
        .returning();
      if (claimed.length === 0) {
        throw DomainError.conflict('This grant request was just decided by someone else — refresh and try again.');
      }
      if (this.auditSink) {
        await this.auditSink
          .record({
            actorId: actor,
            action: 'security.vault_role.cancelled',
            entityType: 'vault_role_grant_request',
            entityId: requestId,
            reason: `requester cancelled the pending role request for user ${request.userId}`,
            result: 'allow',
          })
          .catch(() => {});
      }
      return { vaultRoleGrantRequestId: requestId };
    });
  }

  async listVaultRoleGrantRequests(query: ListQuery): Promise<Page<VaultRoleGrantRequestRow>> {
    const rows = await this.db
      .select()
      .from(vaultRoleGrantRequest)
      .where(
        query.cursor ? lt(vaultRoleGrantRequest.vaultRoleGrantRequestId, query.cursor) : undefined,
      )
      .orderBy(desc(vaultRoleGrantRequest.vaultRoleGrantRequestId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vaultRoleGrantRequestId);
  }

  async getVaultRoleGrantRequestById(id: string): Promise<VaultRoleGrantRequestRow | null> {
    const rows = await this.db
      .select()
      .from(vaultRoleGrantRequest)
      .where(eq(vaultRoleGrantRequest.vaultRoleGrantRequestId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Revoke a user↔role assignment (audit G/#1: RBAC was append-only). Deletes the mapping so the
   * user loses the role on their next token refresh. Only an owner may revoke a top-level admin
   * role, mirroring the grant-side subset guard.
   */
  async revokeUserRole(mappingId: string, principal: AuthPrincipal): Promise<{ userRoleMappingId: string }> {
    const mapping = (
      await this.db
        .select({ id: userRoleMapping.userRoleMappingId, roleId: userRoleMapping.roleId })
        .from(userRoleMapping)
        .where(eq(userRoleMapping.userRoleMappingId, mappingId))
        .limit(1)
    )[0];
    if (!mapping) throw new NotFoundException(`user_role_mapping not found: ${mappingId}`);
    if (mapping.roleId) {
      const role = (
        await this.db.select({ code: roleMaster.roleCode }).from(roleMaster).where(eq(roleMaster.roleId, mapping.roleId)).limit(1)
      )[0];
      const rc = String(role?.code ?? '').toLowerCase();
      const granterRoles = (principal.roles ?? []).map((r) => r.toLowerCase());
      if (['owner', 'super_admin', 'superadmin'].includes(rc) && !granterRoles.includes('owner')) {
        throw DomainError.forbidden('AUTH_FORBIDDEN', `Only an owner may revoke the "${role?.code}" role.`);
      }
    }
    await this.db.delete(userRoleMapping).where(eq(userRoleMapping.userRoleMappingId, mappingId));
    return { userRoleMappingId: mappingId };
  }

  /**
   * Revoke a role↔permission grant (audit G/#1). Deletes the mapping so the role loses the
   * permission. Only an owner may change a top-level admin role's permissions.
   */
  async revokeRolePermission(mappingId: string, principal: AuthPrincipal): Promise<{ rolePermissionMappingId: string }> {
    const mapping = (
      await this.db
        .select({ id: rolePermissionMapping.rolePermissionMappingId, roleId: rolePermissionMapping.roleId })
        .from(rolePermissionMapping)
        .where(eq(rolePermissionMapping.rolePermissionMappingId, mappingId))
        .limit(1)
    )[0];
    if (!mapping) throw new NotFoundException(`role_permission_mapping not found: ${mappingId}`);
    if (mapping.roleId) {
      const role = (
        await this.db.select({ code: roleMaster.roleCode }).from(roleMaster).where(eq(roleMaster.roleId, mapping.roleId)).limit(1)
      )[0];
      const rc = String(role?.code ?? '').toLowerCase();
      const granterRoles = (principal.roles ?? []).map((r) => r.toLowerCase());
      if (['owner', 'super_admin', 'superadmin'].includes(rc) && !granterRoles.includes('owner')) {
        throw DomainError.forbidden('AUTH_FORBIDDEN', `Only an owner may change the "${role?.code}" role's permissions.`);
      }
    }
    await this.db.delete(rolePermissionMapping).where(eq(rolePermissionMapping.rolePermissionMappingId, mappingId));
    return { rolePermissionMappingId: mappingId };
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
