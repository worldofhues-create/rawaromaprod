/**
 * ShelfModule (lane produce) — racks entered in the app, put-away / pick / move at the physical
 * shelves, the printable sheets, the Shelf display, and the pick-to-light connector + simulator.
 * Registered by app.module.ts (HTTP) and worker.module.ts (the pick-light drain's @Interval only
 * fires where the ScheduleModule runs — the worker — exactly like BridgeRelayService).
 */
import { Module } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { ShelfController } from './shelf.controller.js';
import { ShelfLayoutService } from './shelf-layout.service.js';
import { ShelfTaskService } from './shelf-task.service.js';
import { PickLightService } from './pick-light.service.js';
import { SHELF_DB, shelfDb } from './shelf.tokens.js';

@Module({
  controllers: [ShelfController],
  providers: [
    { provide: SHELF_DB, inject: [PG_CLIENT], useFactory: (client: Sql) => shelfDb(client) },
    ShelfLayoutService,
    ShelfTaskService,
    PickLightService,
  ],
  exports: [SHELF_DB, ShelfLayoutService, ShelfTaskService, PickLightService],
})
export class ShelfModule {}
