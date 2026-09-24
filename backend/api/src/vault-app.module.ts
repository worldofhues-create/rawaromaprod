/**
 * VaultAppModule — the composition root for `vault-main.ts` (PB-03 remainder, V4 §109.1's
 * Vault-as-its-own-trust-domain requirement). Loads ONLY what the Vault console needs to
 * function, and NOTHING that would require a credential onto the main schema Postgres
 * (`DATABASE_URL`/`PG_CLIENT`) the isolated Vault EC2 has no network path to at all:
 *
 *   - `ConfigModule` + `JwtModule` — identity. `JwtAuthGuard`/`PermissionsGuard`/`FreshAuthGuard`
 *     (registered globally below, same order `AppModule` uses) verify the RawProd session JWT
 *     the caller already holds (roles/permissions/authTime embedded in the token itself —
 *     `principal.ts`) purely off `JWT_SECRET`, shared with the main app box via SSM. Zero DB
 *     read on the request path — see this file's own "IDENTITY DESIGN" note below for why this
 *     is the chosen shape and what was deliberately NOT built.
 *   - `CryptoModule` — the encrypted `/crypto/handshake` + `/rpc` tunnel `web-vault/vault.js`
 *     talks over (the SAME wire protocol every RawProd client uses). Domain-free, in-memory
 *     only (`SessionKeysService`).
 *   - `FormulaModule` (VAULT_MODE=true — set via this process's env, read at module-decoration
 *     time in `formula.module.ts`) — formulas/versions/lifecycle/approvals/access policies/
 *     audit/KMS adapter, PLUS the plaintext HTTP routes (only this process ever mounts them),
 *     PLUS material-search resolved over the signed facts bridge instead of a local `PG_CLIENT`
 *     (see `formula.module.ts`'s header for the full design + the rejected alternative).
 *   - `VaultPortInternalModule` — the receiving side of the OTHER signed channel: the main app
 *     box's `VaultPortHttpClient` calls in here to resolve a coded manufacturing instruction.
 *   - `VaultHealthModule` — `/health`, pinging `FORMULA_PG_CLIENT` (the one DB connection this
 *     process actually holds) instead of the main `HealthController`'s `PG_CLIENT`.
 *
 * Deliberately NOT imported: `DrizzleModule`/`BackendKernelModule.forRoot()` (needs
 * `DATABASE_URL`), `PlatformModule`/`FlagsModule`-consumers (the platform/flags control plane
 * is a main-mode concept), `ClusterOrgModule` and every other @ra cluster (their schemas +
 * `PG_CLIENT` dependency), `MaterialMaskingInterceptor` (masks `materialId` for clusters this
 * process never imports — inert here, excluded to keep the surface honestly narrow), and
 * `FlagGuard` (its `FlagsService` snapshot is hydrated by `PlatformModule`, never imported here).
 *
 * IDENTITY DESIGN (the lane brief's "pick the design that keeps no main-DB credentials on the
 * vault box; document"): a vault user authenticates the SAME way every other RawProd staff
 * member does — ALEMBIC OTP -> signed assertion -> `POST /auth/alembic-assertion` on the MAIN
 * app box (`cluster-org`'s `AuthService.loginWithAssertion`), which mints the RawProd JWT with
 * roles/permissions embedded. That JWT is then presented to the Vault console exactly like any
 * other bearer token. This process does NOT implement its own `/auth/alembic-assertion` — doing
 * so would require binding the assertion's `sub`/`email` to an `iam.user_master` row (exactly
 * what `AuthService.loginWithAssertion` does) to resolve roles/permissions, which needs the
 * main-schema DB this box must never hold a credential for. The assertion's own `roles` claim is
 * too coarse a substitute (no flattened `domain:resource:action` permission list), so minting a
 * SECOND, parallel, main-DB-free JWT here would mean a second permission-flattening
 * implementation to keep in sync with `ROLE_PERMISSION_MAPPING` — a bigger, riskier surface than
 * "authenticate once on the main box, bring the token here." The replay-protected, audited half
 * of this design that DOES belong on the Vault box is already true unconditionally: every vault
 * read/decrypt/approve is written to `formula.audit_events` (`VaultSecurityAuditSink`, bound by
 * `FormulaModule` regardless of mode) — on the Vault's OWN `FORMULA_DATABASE_URL` connection,
 * never the main DB.
 */
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  AllExceptionsFilter,
  ConfigModule,
  FreshAuthGuard,
  JwtAuthGuard,
  JwtModule,
  PermissionsGuard,
  RequestIdMiddleware,
  ResponseEnvelopeInterceptor,
} from '@core/backend-kernel';
import { FormulaModule } from '@ra/cluster-formula';
import { CryptoModule } from './crypto/crypto.module.js';
import { VaultPortInternalModule } from './vault-bridge/vault-port-internal.module.js';
import { VaultHealthModule } from './vault-bridge/vault-health.module.js';

@Module({
  imports: [
    ConfigModule,
    JwtModule,
    CryptoModule,
    FormulaModule,
    VaultPortInternalModule,
    VaultHealthModule,
  ],
  providers: [
    // Same order as AppModule: authenticate, then authorize, then step-up. No FlagGuard (see
    // header) — routes here carry no @Flag() decorators, and there is no FlagsService snapshot
    // to evaluate against without PlatformModule.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: FreshAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class VaultAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
