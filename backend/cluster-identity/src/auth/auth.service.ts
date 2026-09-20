/**
 * AuthService — the real identity wiring (doc 06 §1, doc 05 §1).
 *
 * - register: create user (+ argon2id credential) and emit `identity.user.registered`
 *   atomically via the transactional outbox.
 * - login: verify argon2id password, mint access (15m) + rotating refresh, persist the
 *   session with the refresh-token HASH (never the token).
 * - refresh: rotate — verify the presented refresh token, match its hash to a live
 *   session, issue a new pair, replace the stored hash (reuse detection seam).
 * - logout: revoke the session.
 * - me: resolve the principal's profile.
 *
 * Permissions are flattened from the user's roles at token-mint time so the edge guards
 * need zero DB hit per request. All cross-cluster signalling is via the outbox event.
 */
import { createHash as nodeCreateHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as argon2 from 'argon2';
import {
  DomainError,
  JwtService,
  IAM_DB,
  iamSchema,
  recordOutbox,
  type IamDb,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { identity, type Portal } from '@core/contracts';
import { uuidv7 } from '@core/data-kernel';
import type {
  AuthResult,
  AuthUser,
  LoginRequest,
  MeProfile,
  RegisterRequest,
  TokenPair,
} from './auth.types.js';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024, // 64 MB (doc 05 §1)
  timeCost: 3,
  parallelism: 1,
};

@Injectable()
export class AuthService {
  constructor(
    @Inject(IAM_DB) private readonly db: IamDb,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  /** Register a new user with a password credential. Emits identity.user.registered. */
  async register(input: RegisterRequest, password: string): Promise<AuthResult> {
    const { users, credentials, outbox } = iamSchema;

    const userId = uuidv7();
    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        fullName: input.fullName,
        mobile: input.mobile ?? null,
        email: input.email ?? null,
        status: 'active',
      });
      await tx.insert(credentials).values({ userId, passwordHash });
      await recordOutbox(
        tx,
        outbox,
        identity.identityEvents.userRegistered,
        { userId, portal: input.portal },
        userId,
      );
    });

    const user = await this.loadAuthUser(userId, input.portal);
    const tokens = await this.issueSession(user, null);
    return { user, tokens };
  }

  /** Password login. (OTP login is a separate path; this covers the password branch.) */
  async login(input: LoginRequest): Promise<AuthResult> {
    if (!input.password) {
      throw DomainError.unauthorized('AUTH_INVALID_CREDENTIALS', 'Password required');
    }
    const { users, credentials } = iamSchema;

    const found = await this.db
      .select({
        id: users.id,
        status: users.status,
        passwordHash: credentials.passwordHash,
      })
      .from(users)
      .innerJoin(credentials, eq(credentials.userId, users.id))
      .where(
        and(
          isNull(users.deletedAt),
          identifierMatches(input.identifier),
        ),
      )
      .limit(1);

    const row = found[0];
    if (!row) {
      throw DomainError.unauthorized('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    }
    const ok = await argon2.verify(row.passwordHash, input.password);
    if (!ok) {
      throw DomainError.unauthorized('AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
    }
    if (row.status === 'suspended') {
      throw DomainError.forbidden('AUTH_FORBIDDEN', 'Account suspended');
    }

    const user = await this.loadAuthUser(row.id, input.portal);
    const tokens = await this.issueSession(user, input.deviceFingerprint ?? null);
    return { user, tokens };
  }

  /** Rotate a refresh token → a fresh access+refresh pair. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const claims = await this.jwt.verifyRefresh(refreshToken);
    const { sessions, users } = iamSchema;

    const presentedHash = hashRefresh(refreshToken);
    const sessionRows = await this.db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        portal: sessions.portalAudience,
        refreshTokenHash: sessions.refreshTokenHash,
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(eq(sessions.id, claims.sid))
      .limit(1);

    const session = sessionRows[0];
    if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
      throw DomainError.unauthorized('AUTH_TOKEN_EXPIRED', 'Session expired');
    }
    // Reuse detection: a presented token whose hash no longer matches the stored one
    // means the family was rotated/stolen — kill the session.
    if (session.refreshTokenHash !== presentedHash) {
      await this.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, session.id));
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'Refresh token reuse detected');
    }

    const userRow = (
      await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, session.userId), isNull(users.deletedAt)))
        .limit(1)
    )[0];
    if (!userRow) {
      throw DomainError.unauthorized('AUTH_TOKEN_INVALID', 'User not found');
    }

    const portal = (session.portal ?? 'buyer') as Portal;
    const user = await this.loadAuthUser(session.userId, portal);
    return this.rotateSession(session.id, user);
  }

  /** Revoke a session (logout). */
  async logout(sessionId: string): Promise<void> {
    const { sessions } = iamSchema;
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  /** `/me` — the current user's profile. */
  async me(principal: AuthPrincipal): Promise<MeProfile> {
    const { users } = iamSchema;
    const row = (
      await this.db
        .select({
          id: users.id,
          fullName: users.fullName,
          mobile: users.mobile,
          email: users.email,
        })
        .from(users)
        .where(and(eq(users.id, principal.userId), isNull(users.deletedAt)))
        .limit(1)
    )[0];
    if (!row) throw DomainError.notFound('User not found');
    return {
      id: row.id,
      fullName: row.fullName ?? '',
      mobile: row.mobile,
      email: row.email,
      photoKey: null,
    };
  }

  // --- internals ---------------------------------------------------------------

  /** Load the user + their role keys for a portal. (Permissions are flattened separately
   *  at mint time by `permissionsFor`.) */
  private async loadAuthUser(userId: string, portal: Portal): Promise<AuthUser> {
    const { users, userRoles, roles } = iamSchema;

    const userRow = (
      await this.db
        .select({
          id: users.id,
          fullName: users.fullName,
          mobile: users.mobile,
          email: users.email,
          status: users.status,
        })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .limit(1)
    )[0];
    if (!userRow) throw DomainError.notFound('User not found');

    const roleRows = await this.db
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));

    return {
      id: userRow.id,
      fullName: userRow.fullName ?? '',
      mobile: userRow.mobile,
      email: userRow.email,
      status: normalizeStatus(userRow.status),
      roles: roleRows.map((r) => r.key),
      portal,
    };
  }

  /** Create a NEW session row and mint the first token pair. */
  private async issueSession(
    user: AuthUser,
    deviceFingerprint: string | null,
  ): Promise<TokenPair> {
    const { sessions } = iamSchema;
    const sessionId = uuidv7();
    void deviceFingerprint; // device row creation is a follow-up; fingerprint logged later.

    const tokens = await this.mintTokens(user, sessionId);
    await this.db.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: hashRefresh(tokens.refreshToken),
      portalAudience: user.portal,
      expiresAt: refreshExpiry(),
    });
    return tokens;
  }

  /** Rotate an EXISTING session: new pair, replace the stored refresh hash. */
  private async rotateSession(sessionId: string, user: AuthUser): Promise<TokenPair> {
    const { sessions } = iamSchema;
    const tokens = await this.mintTokens(user, sessionId);
    await this.db
      .update(sessions)
      .set({
        refreshTokenHash: hashRefresh(tokens.refreshToken),
        expiresAt: refreshExpiry(),
      })
      .where(eq(sessions.id, sessionId));
    return tokens;
  }

  /** Sign an access+refresh pair carrying the resolved permission set. */
  private async mintTokens(user: AuthUser, sessionId: string): Promise<TokenPair> {
    const perms = await this.permissionsFor(user);
    const accessToken = await this.jwt.signAccess({
      sub: user.id,
      portal: user.portal,
      roles: user.roles,
      perms,
      pv: 1,
      sid: sessionId,
    });
    const refreshToken = await this.jwt.signRefresh({ sub: user.id, sid: sessionId });
    return { accessToken, refreshToken, expiresIn: this.jwt.accessTtlSeconds };
  }

  /** Flatten the user's roles → permission strings (for the access token claims). */
  private async permissionsFor(user: AuthUser): Promise<string[]> {
    const { userRoles, rolePermissions, permissions } = iamSchema;
    const rows = await this.db
      .selectDistinct({ key: permissions.key })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(userRoles.userId, user.id));
    return rows.map((r) => r.key);
  }
}

/** Hash a refresh token for at-rest storage (sha-256 hex). */
function hashRefresh(token: string): string {
  return nodeCreateHash('sha256').update(token).digest('hex');
}

/** Refresh-token expiry (30 days). */
function refreshExpiry(): Date {
  return new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
}

/** Build the identifier WHERE clause (mobile OR email). */
function identifierMatches(identifier: string) {
  const { users } = iamSchema;
  return sql`(${users.mobile} = ${identifier} OR ${users.email} = ${identifier})`;
}

function normalizeStatus(status: string): AuthUser['status'] {
  return status === 'active' || status === 'suspended' || status === 'pending'
    ? status
    : 'pending';
}
