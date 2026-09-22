/**
 * BridgeModule — the ALEMBIC↔RawProd channel (§24-27 of the master directive). Uses its
 * own `BRIDGE_DB` Drizzle client off the shared `PG_CLIENT` pool, same pattern as every
 * other cluster module. `BridgeRelayService` (the outbound scheduler) is exported so
 * `worker.module.ts` can register it without importing the whole module's HTTP surface
 * a second time; `BridgeController`/`ImporterService`/`ConfigAdminService` are the HTTP
 * surface, registered by `app.module.ts`.
 */
import { Global, Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { BridgeController } from './bridge.controller.js';
import { ImporterService } from './importer.service.js';
import { ConfigAdminService } from './config-admin.service.js';
import { BridgeRelayService } from './relay.service.js';
import { BRIDGE_DB, drizzle, bridgeSchema } from './bridge.tokens.js';

@Global()
@Module({
  controllers: [BridgeController],
  providers: [
    {
      provide: BRIDGE_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: bridgeSchema }),
    },
    ImporterService,
    ConfigAdminService,
    BridgeRelayService,
  ],
  exports: [BRIDGE_DB, BridgeRelayService],
})
export class BridgeModule {}
