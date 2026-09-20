/**
 * ClusterOrgModule — the RAW AROMACHEM org cluster (iam schema). Mints its own
 * `ORG_DB` Drizzle client off the shared `PG_CLIENT` pool (bound to the @ra/data-org
 * schema barrel), wires the CRUD services + controllers, and exports the `ORG_LOOKUP`
 * cold-read port. Foundation masters: no outbox, no events.
 */
import { Module } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { OrgController } from './org/org.controller.js';
import { OrgService } from './org/org.service.js';
import { SecurityController } from './security/security.controller.js';
import { SecurityService } from './security/security.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
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
  ],
  exports: [ORG_DB, ORG_LOOKUP],
})
export class ClusterOrgModule {}
