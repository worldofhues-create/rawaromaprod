/**
 * ServicePrincipalService — "Ruh (automation)", the Formula Vault's drafting account (lane
 * vaultsetup; owner decision 2026-10-05: "Ruh drafts, one person approves").
 *
 * WHAT RUH IS. One iam.user_master row with account_kind = 'SERVICE': no password, no ALEMBIC
 * identity, no session. AuthService refuses it every sign-in path (password, assertion, refresh);
 * SecurityService refuses it every role but `formulator`, a password and an email change. It is
 * deterministic server code acting under its own audited identity — never an AI model, and no
 * formula content ever passes through anything but the Vault.
 *
 * HOW IT GETS ITS AUTHORITY — THE TWO CLICKS. Exactly the existing two-person Vault-role grant,
 * with no shortcut:
 *   1. an owner/admin clicks "Let Ruh draft formulas" (requestFormulator): the account is created
 *      if it does not exist yet (created_by = that person) and SecurityService.createUserRole opens
 *      the PENDING `formulator` grant request — the same call POST /v1/user-roles makes;
 *   2. a DIFFERENT owner/admin approves it (the existing POST /v1/vault-role-grant-requests/:id/
 *      approve, SecurityService.approveVaultRoleGrant): not the requester, not in the requester's
 *      account-creation chain. Only then does Ruh hold `formulator`.
 * `ruhStatus` shows the pending request and the people who may approve it.
 *
 * HOW IT ACTS. `mintVaultToken` mints a short-lived access token for ONE server-side call to the
 * Vault (the formula shells): roles as granted, and only the three drafting permissions the call
 * needs — never formula:actual:read, never an approval permission (it refuses outright if Ruh were
 * ever found holding one). The token never leaves this process except to the Vault; each mint is
 * recorded on the Vault's tamper-evident audit chain (`security.service_token.minted`).
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  DomainError,
  JwtService,
  SECURITY_AUDIT_SINK,
  type AuthPrincipal,
  type SecurityAuditSink,
} from '@core/backend-kernel';
import { ORG_DB, orgSchema, type OrgDb } from '../cluster-org.tokens.js';
import { SecurityService } from '../security/security.service.js';

const { userMaster, roleMaster, userRoleMapping, rolePermissionMapping, permissionMaster, vaultRoleGrantRequest } = orgSchema;

/** The Ruh service principal's fixed identity. `.invalid` is a reserved TLD: never deliverable,
 *  never an ALEMBIC staff email. */
export const RUH_PRINCIPAL = {
  email: 'ruh.automation@service.rawprod.invalid',
  userName: 'Ruh (automation)',
  employeeCode: 'SVC-RUH',
} as const;

/** The only Vault permissions a Ruh token ever carries — what POST /v1/formula-shells demands. */
export const RUH_DRAFTING_PERMISSIONS = [
  'formula:formula_master:write',
  'formula:formula_version:write',
  'formula:formula_ingredients:write',
] as const;

/** Permissions that would let a principal decide/approve — Ruh must never hold any of them. */
const DECISION_PERMISSIONS = ['formula:formula_approval:write', 'formula:formula_access_policy:write'];

const OWNER_ADMIN = ['owner', 'admin'];

export interface PersonRef {
  userId: string;
  userName: string | null;
  email: string | null;
}

export interface RuhStatus {
  account: { userId: string; userName: string | null; isActive: boolean | null; status: string | null; createdBy: PersonRef | null; createdDt: string } | null;
  formulator:
    | { state: 'none' }
    | { state: 'active'; userRoleMappingId: string }
    | { state: 'pending'; requestId: string; requestedBy: PersonRef | null; requestedDt: string; expiresDt: string; approvers: PersonRef[] };
  /** What the CALLER can do next (the server re-checks on the click). */
  you: { canRequest: boolean; canApprove: boolean; note: string | null };
}

@Injectable()
export class ServicePrincipalService {
  constructor(
    @Inject(ORG_DB) private readonly db: OrgDb,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(SecurityService) private readonly security: SecurityService,
    @Optional() @Inject(SECURITY_AUDIT_SINK) private readonly auditSink?: SecurityAuditSink,
  ) {}

  /** The Ruh account row, or null before the first "Let Ruh draft formulas" click. */
  async findRuh() {
    return (
      await this.db
        .select({
          userId: userMaster.userId,
          userName: userMaster.userName,
          isActive: userMaster.isActive,
          status: userMaster.status,
          accountKind: userMaster.accountKind,
          createdBy: userMaster.createdBy,
          createdDt: userMaster.createdDt,
        })
        .from(userMaster)
        .where(eq(userMaster.email, RUH_PRINCIPAL.email))
        .limit(1)
    )[0] ?? null;
  }

  /** Create the Ruh account if it does not exist yet (owner/admin only). Idempotent. */
  async ensureRuh(principal: AuthPrincipal) {
    assertOwnerAdmin(principal);
    const existing = await this.findRuh();
    if (existing) {
      if (existing.accountKind !== 'SERVICE') {
        throw DomainError.conflict(`${RUH_PRINCIPAL.email} belongs to an ordinary account — Ruh cannot be set up until it is removed.`);
      }
      return existing;
    }
    await this.db
      .insert(userMaster)
      .values({
        email: RUH_PRINCIPAL.email,
        userName: RUH_PRINCIPAL.userName,
        employeeCode: RUH_PRINCIPAL.employeeCode,
        passwordHash: null,
        isActive: true,
        accountKind: 'SERVICE',
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .onConflictDoNothing();
    const row = await this.findRuh();
    if (!row || row.accountKind !== 'SERVICE') throw DomainError.conflict('The Ruh service account could not be created.');
    if (this.auditSink && row.createdBy === principal.userId) {
      await this.auditSink
        .record({
          actorId: principal.userId,
          action: 'security.service_principal.created',
          entityType: 'user_master',
          entityId: row.userId,
          reason: `created the non-login service account "${RUH_PRINCIPAL.userName}"`,
          result: 'allow',
        })
        .catch(() => {});
    }
    return row;
  }

  /** Click 1: ensure the account, then open the PENDING `formulator` grant through the ordinary
   *  two-person flow (SecurityService.createUserRole). Returns the new status. */
  async requestFormulator(principal: AuthPrincipal): Promise<RuhStatus> {
    const ruh = await this.ensureRuh(principal);
    const status = await this.ruhStatus(principal);
    if (status.formulator.state !== 'none') return status;
    const role = (await this.db.select({ roleId: roleMaster.roleId }).from(roleMaster).where(eq(roleMaster.roleCode, 'formulator')).limit(1))[0];
    if (!role) throw DomainError.notFound('The formulator role is not seeded on this deployment (run pnpm db:seed).');
    await this.security.createUserRole({ userId: ruh.userId, roleId: role.roleId }, principal);
    return this.ruhStatus(principal);
  }

  async ruhStatus(principal: AuthPrincipal): Promise<RuhStatus> {
    const ruh = await this.findRuh();
    const isOwnerAdmin = (principal.roles ?? []).some((r) => OWNER_ADMIN.includes(r.toLowerCase()));
    if (!ruh || ruh.accountKind !== 'SERVICE') {
      return {
        account: null,
        formulator: { state: 'none' },
        you: { canRequest: isOwnerAdmin, canApprove: false, note: isOwnerAdmin ? null : 'Only an owner or admin can set Ruh up.' },
      };
    }
    const account = {
      userId: ruh.userId,
      userName: ruh.userName,
      isActive: ruh.isActive,
      status: ruh.status,
      createdBy: await this.person(ruh.createdBy),
      createdDt: ruh.createdDt.toISOString(),
    };

    const mapping = (
      await this.db
        .select({ id: userRoleMapping.userRoleMappingId })
        .from(userRoleMapping)
        .innerJoin(roleMaster, eq(roleMaster.roleId, userRoleMapping.roleId))
        .where(and(eq(userRoleMapping.userId, ruh.userId), eq(roleMaster.roleCode, 'formulator')))
        .limit(1)
    )[0];
    if (mapping) {
      return { account, formulator: { state: 'active', userRoleMappingId: mapping.id }, you: { canRequest: false, canApprove: false, note: null } };
    }

    const pending = (
      await this.db
        .select()
        .from(vaultRoleGrantRequest)
        .where(and(
          eq(vaultRoleGrantRequest.userId, ruh.userId),
          eq(vaultRoleGrantRequest.grantStatus, 'PENDING'),
          gt(vaultRoleGrantRequest.expiresDt, new Date()),
        ))
        .limit(1)
    )[0];
    if (!pending) {
      return {
        account,
        formulator: { state: 'none' },
        you: { canRequest: isOwnerAdmin, canApprove: false, note: isOwnerAdmin ? null : 'Only an owner or admin can ask for Ruh\'s grant.' },
      };
    }
    const approvers = await this.security.vaultGrantApprovers(pending.vaultRoleGrantRequestId);
    const canApprove = approvers.some((a) => a.userId === principal.userId);
    return {
      account,
      formulator: {
        state: 'pending',
        requestId: pending.vaultRoleGrantRequestId,
        requestedBy: await this.person(pending.createdBy),
        requestedDt: pending.createdDt.toISOString(),
        expiresDt: pending.expiresDt.toISOString(),
        approvers,
      },
      you: {
        canRequest: false,
        canApprove,
        note: canApprove
          ? null
          : pending.createdBy === principal.userId
            ? 'You asked for this grant, so a different owner or admin must approve it.'
            : 'Only an independent owner or admin listed here can approve it.',
      },
    };
  }

  /**
   * A short-lived access token for ONE server-side call to the Vault as Ruh — carrying exactly
   * RUH_DRAFTING_PERMISSIONS. Refuses when Ruh does not exist, is inactive, does not (yet) hold
   * all three (the grant is not approved), or — impossible by SecurityService, refused here
   * anyway — holds any decision permission.
   */
  async mintVaultToken(purpose: string): Promise<{ token: string; userId: string }> {
    const ruh = await this.findRuh();
    if (!ruh || ruh.accountKind !== 'SERVICE') {
      throw DomainError.forbidden('AUTH_FORBIDDEN', 'Ruh is not set up yet — an owner must click "Let Ruh draft formulas" and a second owner approve it.');
    }
    const statusUpper = ruh.status ? ruh.status.toUpperCase() : null;
    if (ruh.isActive === false || (statusUpper !== null && statusUpper !== 'ACTIVE')) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', 'The Ruh service account is switched off.');
    }
    const roles = (
      await this.db
        .select({ code: roleMaster.roleCode })
        .from(userRoleMapping)
        .innerJoin(roleMaster, eq(roleMaster.roleId, userRoleMapping.roleId))
        .where(eq(userRoleMapping.userId, ruh.userId))
    ).map((r) => r.code).filter((c): c is string => !!c);
    const held = new Set(
      (
        await this.db
          .selectDistinct({ code: permissionMaster.permissionCode })
          .from(userRoleMapping)
          .innerJoin(rolePermissionMapping, eq(rolePermissionMapping.roleId, userRoleMapping.roleId))
          .innerJoin(permissionMaster, eq(permissionMaster.permissionId, rolePermissionMapping.permissionId))
          .where(eq(userRoleMapping.userId, ruh.userId))
      ).map((r) => r.code).filter((c): c is string => !!c),
    );
    const decision = DECISION_PERMISSIONS.filter((p) => held.has(p));
    if (decision.length > 0) {
      await this.audit(ruh.userId, 'security.service_token.refused', `Ruh holds a decision permission (${decision.join(', ')}) — refused`, 'refuse');
      throw DomainError.forbidden('AUTH_FORBIDDEN', 'Ruh must never hold an approval permission; refusing to act as it.');
    }
    const missing = RUH_DRAFTING_PERMISSIONS.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        'Ruh is not allowed to draft formulas yet — the formulator grant needs a second owner\'s approval.',
      );
    }
    const token = await this.jwt.signAccess({
      sub: ruh.userId,
      portal: 'owner',
      roles,
      perms: [...RUH_DRAFTING_PERMISSIONS],
      pv: 1,
      sid: randomUUID(),
      authTime: Math.floor(Date.now() / 1000),
    });
    await this.audit(ruh.userId, 'security.service_token.minted', `Ruh token for: ${purpose.slice(0, 200)}`, 'allow');
    return { token, userId: ruh.userId };
  }

  private async audit(entityId: string, action: string, reason: string, result: 'allow' | 'refuse'): Promise<void> {
    if (!this.auditSink) return;
    await this.auditSink
      .record({ actorId: entityId, action, entityType: 'user_master', entityId, reason, result })
      .catch(() => {});
  }

  private async person(userId: string | null): Promise<PersonRef | null> {
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
    const row = (
      await this.db
        .select({ userId: userMaster.userId, userName: userMaster.userName, email: userMaster.email })
        .from(userMaster)
        .where(eq(userMaster.userId, userId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}

function assertOwnerAdmin(principal: AuthPrincipal): void {
  if (!(principal.roles ?? []).some((r) => OWNER_ADMIN.includes(r.toLowerCase()))) {
    throw DomainError.forbidden('AUTH_FORBIDDEN', 'Only an owner or admin can set up the Ruh service account.');
  }
}
