/**
 * AuthService — login against the dictionary USER_MASTER (Phase-1A). Verifies the Argon2id
 * password_hash, flattens the user's roles (USER_ROLE_MAPPING → ROLE_MASTER) and permissions
 * (→ ROLE_PERMISSION_MAPPING → PERMISSION_MASTER) and mints the access/refresh tokens the
 * @core edge guards already consume. The access token carries the roles but only the
 * vault-scoped permissions (`JwtService.signAccess` narrows them); the main box resolves the
 * rest from roles per request (`RolePermissionResolver`), and `/me` returns the full list for
 * the UI. `setPassword` hashes + stores a user's password.
 *
 * MVP note: no server-side session store yet (the dictionary has no sessions table), so
 * refresh is stateless re-mint without reuse-detection — a hardening follow-up.
 */
import { HttpException, HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, lt } from "drizzle-orm";
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

/** LANE D1 — the demo showcase role (scripts/ra-roles.ts). It may hold a RawProd session ONLY
 *  when this deployment's RAWPROD_ENVIRONMENT is `demo`, ONLY by way of an ALEMBIC assertion
 *  minted by a demo ALEMBIC (never a password), and its sessions never refresh — so an ALEMBIC
 *  administrator's kill switch reaches a held RawProd showcase session within one access-token
 *  lifetime (JWT_ACCESS_TTL), and a re-open is refused by ALEMBIC at the assertion. */
const SHOWCASE_ROLE = "showcase";

// Login lockout thresholds (audit LOW): N failures per identifier → locked for the window.
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // In-memory brute-force throttle keyed by identifier (per-process; a shared store is the Stage-1 swap).
  private readonly loginFails = new Map<string, { count: number; until: number }>();

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

  /**
   * Single-use check for an assertion's `jti` — S3 security review item 4. Postgres-backed
   * (`iam.assertion_jti`), not the old in-process `Map`: the old store's own doc candidly
   * called out its exposure ("two API processes each accept one presentation inside that
   * same short window") for a multi-process deployment, which the AWS target topology (a load
   * balancer over more than one API process) actually is. `INSERT ... ON CONFLICT DO NOTHING`
   * is atomic across every process sharing the one Postgres — the first process to reach this
   * for a given `jti` wins the row; every other process (including a genuinely concurrent
   * presentation) sees zero rows back and reads it as a replay, regardless of process
   * boundaries. Sweeps expired rows lazily on every call, the same "no cron job needed" shape
   * `expireVaultRoleGrant` uses elsewhere in this codebase.
   */
  private async consumeAssertionJti(jti: string, expSec: number): Promise<boolean> {
    const { assertionJti } = orgSchema;
    try {
      await this.db.delete(assertionJti).where(lt(assertionJti.expiresAt, new Date()));
    } catch (e) {
      // Best-effort — a sweep failure must never block (or falsely allow) the actual
      // single-use check below.
      this.logger.warn(`assertion jti sweep failed: ${(e as Error).message}`);
    }
    const inserted = await this.db
      .insert(assertionJti)
      .values({ jti, expiresAt: new Date(expSec * 1000) })
      .onConflictDoNothing()
      .returning({ jti: assertionJti.jti });
    return inserted.length > 0;
  }

  /** S4 security review finding N2 — true if `userId` currently holds a LIVE (not yet decided,
   *  not yet expired) PENDING `vault_role_grant_request`. Sibling check to
   *  `SecurityService.hasPendingVaultRoleGrant` (that file's own doc has the full reasoning);
   *  duplicated here in a couple of lines rather than reached for through a new cross-service
   *  dependency, because `AuthService` has no existing wiring to `SecurityService` and this
   *  read is the only thing it needs from it. A PENDING row past its own `expiresDt` reads as
   *  "no live request" — this is a read-only guard, not the lazy sweep `approveVaultRoleGrant`
   *  performs. */
  private async hasPendingVaultRoleGrant(userId: string): Promise<boolean> {
    const { vaultRoleGrantRequest } = orgSchema;
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

    // LANE D1: the showcase account never signs in with a password, in any environment.
    if (roles.includes(SHOWCASE_ROLE)) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", "The demo showcase signs in only from the ALEMBIC demo.");
    }

    // Two-console gate: when a console is DECLARED (CONSOLE=online|factory), refuse a session whose
    // roles don't belong to it. Unset = unified single console (the current deployment) → no gate.
    const consoleEnv = process.env.CONSOLE;
    if ((consoleEnv === "online" || consoleEnv === "factory") && !consoleAllows(consoleEnv, roles)) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", `This account is not permitted on the ${consoleEnv} console.`);
    }

    // S3 security review item 13: a random per-session id, never the userId (which every
    // session for the same user would then share, making sessionId useless for a future
    // per-session revoke). Item 2: a password login IS the fresh proof, so authTime = now,
    // same as iat.
    const sid = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);
    const accessToken = await this.jwt.signAccess({
      sub: row.userId,
      portal: RA_PORTAL,
      roles,
      perms,
      pv: 1,
      sid,
      authTime: nowSec,
    });
    const refreshToken = await this.jwt.signRefresh({ sub: row.userId, sid, authTime: nowSec });
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
   *  unchanged: `rolesFor`/`permissionsFor` off `user_master`'s own grants.
   *
   *  S3 SECURITY REVIEW ITEM 1 — SUBJECT BINDING, NOT EMAIL-ONLY MAPPING. The original
   *  version mapped an assertion to a `user_master` row by EMAIL ALONE. Combined with
   *  `EditService`'s generic PATCH once exposing `email` as an editable column, that was a
   *  vault-takeover path: anyone holding `iam:user_master:write` could retarget a privileged
   *  account's email to an address they control on ALEMBIC and sign in as that account.
   *  `user_master.alembic_subject` closes it: the FIRST successful assertion login for a row
   *  with no subject yet BINDS it (`claims.sub`); every login after that must match the bound
   *  subject — an assertion presenting the right EMAIL but a DIFFERENT subject is refused
   *  outright, never silently re-bound.
   *
   *  S4 SECURITY REVIEW FINDING N1 — `claims.sub` IS ALEMBIC'S IMMUTABLE `staff_user.id` (a
   *  uuid), NOT `staff:<email>`. It used to be the latter (`Actor.id` on the ALEMBIC side), which
   *  made this very binding effectively email-bound after all: a colleague's email change on
   *  ALEMBIC minted a brand-new `sub` for the same human, so the OLD binding on this row went
   *  stale and a lookup-by-email fallback (right below) could re-bind the row to whatever
   *  DIFFERENT account now happened to hold that email string. A `sub` that never changes for
   *  the life of the ALEMBIC staff account closes that: `email` still travels as its own claim
   *  (used only for the byEmail fallback and for display), but it is no longer what identity is
   *  proved against.
   *
   *  S4 SECURITY REVIEW FINDING N2 — AN ACCOUNT MID-GRANT MAY NOT BE FIRST-BOUND. A row with a
   *  live PENDING `vault_role_grant_request` is refused here even when its email matches and it
   *  has no subject yet (see `hasPendingVaultRoleGrant` below) — the account is moments from
   *  becoming Vault-authority-holding, and that is exactly the window an attacker most wants to
   *  claim the ALEMBIC binding in, before `SecurityService.changeUserEmail`'s own refusal for a
   *  CURRENT holder would even apply. */
  async loginWithAssertion(assertion: string): Promise<LoginResult> {
    const verifyKey = this.config.get('ALEMBIC_ASSERTION_VERIFY_KEY');
    if (!verifyKey) {
      throw DomainError.featureDisabled(
        'ALEMBIC_ASSERTION_VERIFY_KEY is not configured; sign-in via ALEMBIC is unavailable.',
      );
    }
    const now = new Date();
    /* In production the target/tenant binding is mandatory: an unset value would silently
       accept an assertion minted for another console or tenant (security review item 3). */
    if (this.config.get('APP_ENV') === 'prod' &&
        (!this.config.get('RAWPROD_ASSERTION_EXPECTED_TARGETS') || !this.config.get('ALEMBIC_ASSERTION_TENANT_ID'))) {
      throw DomainError.featureDisabled(
        'RAWPROD_ASSERTION_EXPECTED_TARGETS and ALEMBIC_ASSERTION_TENANT_ID must be set in production; sign-in via ALEMBIC is refused.',
      );
    }
    const expectedTargetsRaw = this.config.get('RAWPROD_ASSERTION_EXPECTED_TARGETS');
    const expectedTargets = expectedTargetsRaw
      ? expectedTargetsRaw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      : undefined;
    const verified = verifyAlembicAssertion({
      token: assertion,
      verifyKeyB64: verifyKey,
      issuer: this.config.get('ALEMBIC_ASSERTION_ISSUER'),
      audience: this.config.get('ALEMBIC_ASSERTION_AUDIENCE'),
      now,
      expectedTargets,
      expectedTenantId: this.config.get('ALEMBIC_ASSERTION_TENANT_ID') || undefined,
      // LANE D1: a demo assertion only in a demo deployment, a production one only in production.
      expectedEnvironment: this.config.get('RAWPROD_ENVIRONMENT'),
    });
    if (!verified.ok) {
      throw new DomainError('AUTH_ASSERTION_INVALID', verified.detail, 401);
    }
    const { claims } = verified;

    // SINGLE-USE, CHECKED RIGHT AFTER CRYPTOGRAPHIC VALIDITY — before any DB lookup,
    // so a replayed token is refused as a replay even if the account it names has since
    // been provisioned or suspended. Postgres-backed (S3 item 4) — see consumeAssertionJti.
    if (!(await this.consumeAssertionJti(claims.jti, claims.exp))) {
      throw new DomainError('AUTH_ASSERTION_REPLAYED', 'This sign-in link has already been used.', 401);
    }

    const { userMaster } = orgSchema;
    const email = claims.email.toLowerCase();
    const USER_COLS = {
      userId: userMaster.userId,
      userName: userMaster.userName,
      email: userMaster.email,
      isActive: userMaster.isActive,
      status: userMaster.status,
      alembicSubject: userMaster.alembicSubject,
    } as const;

    // First: a row already bound to THIS subject is authoritative, regardless of what its
    // email column currently holds — a subject, once bound, is the identity; email is no
    // longer load-bearing for lookup (only for display / the unknown-user message below).
    let row = (
      await this.db.select(USER_COLS).from(userMaster).where(eq(userMaster.alembicSubject, claims.sub)).limit(1)
    )[0];

    if (!row) {
      const byEmail = (
        await this.db.select(USER_COLS).from(userMaster).where(eq(userMaster.email, email)).limit(1)
      )[0];
      if (!byEmail) {
        throw new DomainError(
          'AUTH_UNKNOWN_USER',
          `No RawProd account is provisioned for ${email}. Ask an administrator to create one before opening this console.`,
          401,
        );
      }
      if (byEmail.alembicSubject) {
        // This email already belongs to a row bound to a DIFFERENT ALEMBIC subject. Never
        // silently re-bind — that is exactly the account-hijack path item 1 closes. This
        // shape (right email, wrong subject) is what an email-hijacked account looks like the
        // moment its attacker tries to sign in on the identity they actually control.
        throw DomainError.forbidden(
          'AUTH_FORBIDDEN',
          'This account is bound to a different ALEMBIC identity. Sign-in refused — contact an administrator.',
        );
      }
      // S4 finding N2: refuse first-bind outright for an account mid-grant for a
      // Vault-authority role — see hasPendingVaultRoleGrant's own doc above.
      if (await this.hasPendingVaultRoleGrant(byEmail.userId)) {
        throw DomainError.forbidden(
          'AUTH_FORBIDDEN',
          'This account has a pending Vault-authority role grant request and cannot be bound to an ALEMBIC identity yet. Ask an administrator to resolve the pending request first.',
        );
      }
      // First successful assertion login for this row — bind it now.
      await this.db
        .update(userMaster)
        .set({ alembicSubject: claims.sub, updatedBy: 'system:alembic-assertion' })
        .where(eq(userMaster.userId, byEmail.userId));
      row = { ...byEmail, alembicSubject: claims.sub };
    }

    // S3 security review item 12: refuse whatever suspension signal this row carries, not
    // only the boolean. `is_active = false` is the original column; `status` (metaColumns,
    // ACTIVE/INACTIVE/SUSPENDED/…) is the dictionary-wide lifecycle column every other master
    // table already uses — a row suspended via `status` alone (is_active left true/null) must
    // refuse exactly like one suspended via is_active.
    const statusUpper = row.status ? row.status.toUpperCase() : null;
    if (row.isActive === false || (statusUpper !== null && statusUpper !== 'ACTIVE')) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', 'Account inactive');
    }

    const roles = await this.rolesFor(row.userId);
    const perms = await this.permissionsFor(row.userId);

    // LANE D1: the showcase role holds a session only in a DEMO deployment. A `showcase` row that
    // exists in production (seeded, or granted by mistake) authenticates nobody — the same rule
    // ALEMBIC applies to its own demo account.
    if (roles.includes(SHOWCASE_ROLE) && this.config.get('RAWPROD_ENVIRONMENT') !== 'demo') {
      throw DomainError.forbidden('AUTH_FORBIDDEN', 'Demo access is not available on this deployment.');
    }

    // Same two-console gate password sign-in already honours — unset CONSOLE (this
    // deployment's current shape) applies no gate.
    const consoleEnv = process.env.CONSOLE;
    if ((consoleEnv === 'online' || consoleEnv === 'factory') && !consoleAllows(consoleEnv, roles)) {
      throw DomainError.forbidden('AUTH_FORBIDDEN', `This account is not permitted on the ${consoleEnv} console.`);
    }

    // S3 security review item 13: random per-session sid, never row.userId. Item 2: authTime
    // comes from the assertion's OWN auth_time (the OTP-verification/step-up time ALEMBIC
    // proved), never "now" — a fresh RawProd token minted off a not-so-fresh ALEMBIC session
    // must not read as a fresh authentication for @FreshAuth's purposes.
    const sid = randomUUID();
    const accessToken = await this.jwt.signAccess({
      sub: row.userId,
      portal: RA_PORTAL,
      roles,
      perms,
      pv: 1,
      sid,
      authTime: claims.auth_time,
    });
    const refreshToken = await this.jwt.signRefresh({ sub: row.userId, sid, authTime: claims.auth_time });
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
    let claims: { sub: string; sid: string; authTime: number };
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

    // LANE D1: a showcase session NEVER refreshes. It lives one access-token lifetime and is then
    // re-opened from ALEMBIC, which refuses the assertion while the demo kill switch is off — so
    // switching demo access off in ALEMBIC reaches a held RawProd showcase session within
    // JWT_ACCESS_TTL, deterministically, without RawProd having to ask ALEMBIC anything.
    if (roles.includes(SHOWCASE_ROLE)) {
      throw DomainError.unauthorized("AUTH_TOKEN_INVALID", "Demo sessions do not refresh. Re-open RawProd from the ALEMBIC demo.");
    }

    // Two-console gate: when a console is DECLARED (CONSOLE=online|factory), refuse a session whose
    // roles don't belong to it. Unset = unified single console (the current deployment) → no gate.
    const consoleEnv = process.env.CONSOLE;
    if ((consoleEnv === "online" || consoleEnv === "factory") && !consoleAllows(consoleEnv, roles)) {
      throw DomainError.forbidden("AUTH_FORBIDDEN", `This account is not permitted on the ${consoleEnv} console.`);
    }

    // S3 security review items 2/13: carry the ORIGINAL sid and authTime forward unchanged —
    // a refresh re-presents an existing session's bearer token, it does not start a new
    // session and it is not a fresh proof of the credential. Minting a new random sid (or a
    // fresh authTime) here would be a DIFFERENT session and a false "just authenticated"
    // signal respectively, either of which defeats a step-up window measured off authTime.
    const accessToken = await this.jwt.signAccess({
      sub: row.userId,
      portal: RA_PORTAL,
      roles,
      perms,
      pv: 1,
      sid: claims.sid,
      authTime: claims.authTime,
    });
    const newRefresh = await this.jwt.signRefresh({ sub: row.userId, sid: claims.sid, authTime: claims.authTime });
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
