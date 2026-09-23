/**
 * AuthService — login against the dictionary USER_MASTER (Phase-1A). Verifies the Argon2id
 * password_hash, flattens the user's roles (USER_ROLE_MAPPING → ROLE_MASTER) and permissions
 * (→ ROLE_PERMISSION_MAPPING → PERMISSION_MASTER) and mints the access/refresh tokens the
 * @core edge guards already consume. `setPassword` hashes + stores a user's password.
 *
 * MVP note: no server-side session store yet (the dictionary has no sessions table), so
 * refresh is stateless re-mint without reuse-detection — a hardening follow-up.
 */
import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import * as argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { DomainError, JwtService, PG_CLIENT, ConfigService, type AuthPrincipal } from "@core/backend-kernel";
import type { Portal } from "@core/contracts";
import { ORG_DB, orgSchema, type OrgDb } from "../cluster-org.tokens.js";
import { verifyAlembicAssertion } from "./alembic-assertion.js";

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
};

// RA is a single manufacturing tenant; the access-token audience is fixed for now.
const RA_PORTAL: Portal = "owner";

// Console access policy (Step 3, two-console): which roles may log into which console. Owner + admin
// are cross-console governance; floor roles are factory-only; sales/procurement are online-only. So a
// factory-floor account can't authenticate on the public online console, and vice-versa.
const FACTORY_ONLY_ROLES = ["receiving", "qc", "warehouse", "compounding", "filling", "packaging", "production"];
const ONLINE_ONLY_ROLES = ["sales", "procurement"];
function consoleAllows(consoleEnv: "online" | "factory", roleCodes: string[]): boolean {
  const roles = roleCodes.map((r) => r.toLowerCase());
  if (roles.includes("owner") || roles.includes("admin")) return true; // governance: both consoles
  const permitted = consoleEnv === "factory" ? FACTORY_ONLY_ROLES : ONLINE_ONLY_ROLES;
  return roles.some((r) => permitted.includes(r));
}

export interface LoginResult {
  user: { userId: string; userName: string | null; email: string | null };
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Login lockout thresholds (audit LOW): N failures per identifier → locked for the window.
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // In-memory brute-force throttle keyed by identifier (per-process; a shared store is the Stage-1 swap).
  private readonly loginFails = new Map<string, { count: number; until: number }>();

  // PB-04/SB-02: single-use guard for `iat`-scoped assertion jtis. In-memory / per-process,
  // same MVP posture as `loginFails` above ("a shared store is the Stage-1 swap") — a token
  // this short-lived (<=60s, PB-04's ceiling) is spent within seconds of being minted, so a
  // multi-process deployment's exposure is "two API processes each accept one presentation
  // inside that same short window", not an unbounded replay. Swept lazily on every check.
  private readonly usedAssertionJti = new Map<string, number>(); // jti -> exp (unix seconds)

  constructor(
    @Inject(ORG_DB) private readonly db: OrgDb,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  // Password sign-in is RETIRED for launch (FINAL_OS §2.4/§9). Production refuses it
  // UNCONDITIONALLY; PASSWORD_LOGIN_ENABLED (default OFF) is a non-prod escape hatch for a
  // suite or a local dev box with no ALEMBIC to hand — it can never re-enable the rail once
  // APP_ENV=prod, because that check runs first and is not gated by the flag.
  private passwordLoginAllowed(): boolean {
    if (this.config.isProd) return false;
    return this.config.get('PASSWORD_LOGIN_ENABLED');
  }

  /** Single-use check for an assertion's `jti`. True the FIRST time a given jti is seen
   *  before its own expiry; false on any later presentation (replay) — checked regardless
   *  of what the rest of verification decides, so a spent token cannot be retried against a
   *  different (or now-provisioned) email either. */
  private consumeAssertionJti(jti: string, expSec: number, nowMs: number): boolean {
    for (const [seenJti, seenExpSec] of this.usedAssertionJti) {
      if (seenExpSec * 1000 <= nowMs) this.usedAssertionJti.delete(seenJti);
    }
    if (this.usedAssertionJti.has(jti)) return false;
    this.usedAssertionJti.set(jti, expSec);
    return true;
  }

  /** Record a login in iam.login_history so the admin Login-history view has data (audit
   * requirement). We use a dedicated table keyed to iam.user_master rather than the legacy
   * iam.sessions (whose user_id FK points at the unused iam.users identity table, making it
   * impossible to record real app users). Stores the SHA-256 of the refresh token — never the
   * raw token. Best-effort: a failure here must not block login. */
  private async recordSession(userId: string, refreshToken: string): Promise<void> {
    try {
      const refreshHash = createHash("sha256").update(refreshToken).digest("hex");
      await this.sql`
        insert into iam.login_history (id, user_id, portal_audience, refresh_token_hash, expires_at)
        values (${randomUUID()}, ${userId}, ${RA_PORTAL}, ${refreshHash}, now() + interval '30 days')`;
    } catch (e) {
      this.logger.warn(`session record failed: ${(e as Error).message}`);
    }
  }

  /** Count a failed login; lock the identifier once it exceeds the threshold. */
  private recordLoginFail(key: string): void {
    const g = this.loginFails.get(key) ?? { count: 0, until: 0 };
    g.count += 1;
    if (g.count >= LOGIN_MAX_FAILS) {
      g.until = Date.now() + LOGIN_LOCK_MS;
      g.count = 0;
    }
    this.loginFails.set(key, g);
  }

  /** Password login against user_master (identifier = email). RETIRED for launch —
   *  see `passwordLoginAllowed()`. */
  async login(identifier: string, password: string): Promise<LoginResult> {
    if (!this.passwordLoginAllowed()) {
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        'Password sign-in is retired. Sign in via ALEMBIC.',
      );
    }
    const { userMaster } = orgSchema;
    const key = String(identifier ?? '').toLowerCase();
    // Login lockout (audit LOW): refuse once an identifier has failed too many times recently.
    const gate = this.loginFails.get(key);
    if (gate && gate.until > Date.now()) {
      throw new HttpException('Too many failed login attempts — try again in a few minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
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
      this.recordLoginFail(key);
      throw DomainError.unauthorized("AUTH_INVALID_CREDENTIALS", "Invalid credentials");
    }
    const ok = await argon2.verify(row.passwordHash, password);
    if (!ok) {
      this.recordLoginFail(key);
      throw DomainError.unauthorized("AUTH_INVALID_CREDENTIALS", "Invalid credentials");
    }
    this.loginFails.delete(key); // success clears the counter
    if (row.isActive === false) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", "Account inactive");
    }

    const roles = await this.rolesFor(row.userId);
    const perms = await this.permissionsFor(row.userId);

    // Two-console gate: when a console is DECLARED (CONSOLE=online|factory), refuse a session whose
    // roles don't belong to it. Unset = unified single console (the current deployment) → no gate.
    const consoleEnv = process.env.CONSOLE;
    if ((consoleEnv === "online" || consoleEnv === "factory") && !consoleAllows(consoleEnv, roles)) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", `This account is not permitted on the ${consoleEnv} console.`);
    }

    const accessToken = await this.jwt.signAccess({
      sub: row.userId,
      portal: RA_PORTAL,
      roles,
      perms,
      pv: 1,
      sid: row.userId,
    });
    const refreshToken = await this.jwt.signRefresh({ sub: row.userId, sid: row.userId });
    await this.recordSession(row.userId, refreshToken);
    return {
      user: { userId: row.userId, userName: row.userName, email: row.email },
      accessToken,
      refreshToken,
      expiresIn: this.jwt.accessTtlSeconds,
    };
  }

  /** PB-04 / SB-02 — the one-login identity bridge. Verifies a short-lived assertion
   *  ALEMBIC signed, maps it to an EXISTING `user_master` row by email (NO
   *  auto-provisioning — an unknown email is refused with a clear message, never
   *  silently created as a privileged user), and mints RawProd's OWN access/refresh
   *  tokens exactly as `login()` does. Because this always mints a BRAND-NEW token
   *  (`iat` = now), a Vault route gated by `@FreshAuth()` reads it as fresh the moment
   *  it is used — no change needed to `FreshAuthGuard`'s semantics; a fresh ALEMBIC
   *  OTP assertion IS the re-authentication.
   *
   *  ROLES AND PERMISSIONS COME FROM THIS DEPLOYMENT'S OWN TABLES, never from the
   *  assertion's `roles` claim — that claim is ALEMBIC's coarse "even allowed to try"
   *  gate (see `rawprod-eligibility.ts` in that repository) and carries no authority
   *  here. The existing role/permission mapping this rail has always used is
   *  unchanged: `rolesFor`/`permissionsFor` off `user_master`'s own grants. */
  async loginWithAssertion(assertion: string): Promise<LoginResult> {
    const verifyKey = this.config.get('ALEMBIC_ASSERTION_VERIFY_KEY');
    if (!verifyKey) {
      throw DomainError.featureDisabled(
        'ALEMBIC_ASSERTION_VERIFY_KEY is not configured; sign-in via ALEMBIC is unavailable.',
      );
    }
    const now = new Date();
    const verified = verifyAlembicAssertion({
      token: assertion,
      verifyKeyB64: verifyKey,
      issuer: this.config.get('ALEMBIC_ASSERTION_ISSUER'),
      audience: this.config.get('ALEMBIC_ASSERTION_AUDIENCE'),
      now,
    });
    if (!verified.ok) {
      throw new DomainError('AUTH_ASSERTION_INVALID', verified.detail, 401);
    }
    const { claims } = verified;

    // SINGLE-USE, CHECKED RIGHT AFTER CRYPTOGRAPHIC VALIDITY — before any DB lookup,
    // so a replayed token is refused as a replay even if the account it names has since
    // been provisioned or suspended.
    if (!this.consumeAssertionJti(claims.jti, claims.exp, now.getTime())) {
      throw new DomainError('AUTH_ASSERTION_REPLAYED', 'This sign-in link has already been used.', 401);
    }

    const { userMaster } = orgSchema;
    const email = claims.email.toLowerCase();
    const row = (
      await this.db
        .select({
          userId: userMaster.userId,
          userName: userMaster.userName,
          email: userMaster.email,
          isActive: userMaster.isActive,
        })
        .from(userMaster)
        .where(eq(userMaster.email, email))
        .limit(1)
    )[0];
    if (!row) {
      throw new DomainError(
        'AUTH_UNKNOWN_USER',
        `No RawProd account is provisioned for ${email}. Ask an administrator to create one before opening this console.`,
        401,
      );
    }
    if (row.isActive === false) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', 'Account inactive');
    }

    const roles = await this.rolesFor(row.userId);
    const perms = await this.permissionsFor(row.userId);

    // Same two-console gate password sign-in already honours — unset CONSOLE (this
    // deployment's current shape) applies no gate.
    const consoleEnv = process.env.CONSOLE;
    if ((consoleEnv === 'online' || consoleEnv === 'factory') && !consoleAllows(consoleEnv, roles)) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', `This account is not permitted on the ${consoleEnv} console.`);
    }

    const accessToken = await this.jwt.signAccess({
      sub: row.userId,
      portal: RA_PORTAL,
      roles,
      perms,
      pv: 1,
      sid: row.userId,
    });
    const refreshToken = await this.jwt.signRefresh({ sub: row.userId, sid: row.userId });
    await this.recordSession(row.userId, refreshToken);
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

    // Two-console gate: when a console is DECLARED (CONSOLE=online|factory), refuse a session whose
    // roles don't belong to it. Unset = unified single console (the current deployment) → no gate.
    const consoleEnv = process.env.CONSOLE;
    if ((consoleEnv === "online" || consoleEnv === "factory") && !consoleAllows(consoleEnv, roles)) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", `This account is not permitted on the ${consoleEnv} console.`);
    }

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

  /** Hash + store a user's password (admin-gated, with a rank guard). */
  async setPassword(
    userId: string,
    password: string,
    principal: AuthPrincipal,
  ): Promise<{ userId: string }> {
    if (!this.passwordLoginAllowed()) {
      throw DomainError.forbidden(
        'AUTH_FORBIDDEN',
        'Password sign-in is retired; there is no password to set. Sign in via ALEMBIC.',
      );
    }
    const { userMaster, userRoleMapping, roleMaster } = orgSchema;
    const exists = (
      await this.db
        .select({ userId: userMaster.userId })
        .from(userMaster)
        .where(eq(userMaster.userId, userId))
        .limit(1)
    )[0];
    if (!exists) throw DomainError.notFound("User not found");

    // Rank guard (audit H-S2): only an owner may reset a privileged user's password — otherwise an
    // admin (who holds iam:user_master:write) could overwrite the owner's hash and log in as owner.
    const targetRoles = (
      await this.db
        .select({ code: roleMaster.roleCode })
        .from(userRoleMapping)
        .innerJoin(roleMaster, eq(roleMaster.roleId, userRoleMapping.roleId))
        .where(eq(userRoleMapping.userId, userId))
    ).map((r) => String(r.code ?? "").toLowerCase());
    const principalRoles = (principal.roles ?? []).map((r) => r.toLowerCase());
    const targetPrivileged = targetRoles.some((r) =>
      ["owner", "super_admin", "superadmin", "admin"].includes(r),
    );
    if (targetPrivileged && !principalRoles.includes("owner") && userId !== principal.userId) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", "Only an owner may reset a privileged user's password.");
    }

    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
    await this.db
      .update(userMaster)
      .set({ passwordHash, updatedBy: principal.userId })
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
