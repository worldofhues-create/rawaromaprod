/**
 * ClusterOrgModule — the RAW AROMACHEM org cluster (iam schema). Mints its own
 * `ORG_DB` Drizzle client off the shared `PG_CLIENT` pool (bound to the @ra/data-org
 * schema barrel), wires the CRUD services + controllers, and exports the `ORG_LOOKUP`
 * cold-read port. Foundation masters: no outbox, no events.
 *
 * `OrgService` is also exported (concrete class, not just the cold-read port) so
 * `backend/api/src/platform-ops` can reuse `listOrgs` for the Platform Ops "tenant/
 * organization list" screen (§6) without a second org_master query implementation —
 * it maps the result down to id/code/name/status only, so no other org_master column
 * leaks into that platform_super_admin-only, no-tenant-business-data surface.
 *
 * `PERMISSION_RESOLVER` is exported for `AppModule`'s global `JwtAuthGuard`: this cluster owns
 * the IAM tables, so it is the one that resolves a token's roles to permissions server-side
 * (`RolePermissionResolver`).
 */
import { Module } from '@nestjs/common';
import { PERMISSION_RESOLVER, PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { OrgController } from './org/org.controller.js';
import { OrgService } from './org/org.service.js';
import { SecurityController } from './security/security.controller.js';
import { SecurityService } from './security/security.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { RolePermissionResolver } from './auth/role-permission.resolver.js';
import { OrgLookupService } from './cluster-org-lookup.service.js';
import { ORG_DB, drizzle, orgSchema } from './cluster-org.tokens.js';
import { ORG_LOOKUP } from './public-api.js';

@Module({
  controllers: [OrgController, SecurityController, AuthController],
  providers: [
    {
      provide: ORG_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: orgSchema }),
    },
    OrgService,
    SecurityService,
    AuthService,
    OrgLookupService,
    { provide: ORG_LOOKUP, useExisting: OrgLookupService },
    RolePermissionResolver,
    { provide: PERMISSION_RESOLVER, useExisting: RolePermissionResolver },
  ],
  exports: [ORG_DB, ORG_LOOKUP, OrgService, PERMISSION_RESOLVER],
})
export class ClusterOrgModule {}
