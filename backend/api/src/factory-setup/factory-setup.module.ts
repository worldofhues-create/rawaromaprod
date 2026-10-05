/**
 * FactorySetupModule (FACTORY-SETUP, lane catalogue) — ALEMBIC's catalogue arriving over the
 * signed bridge, the setup checklist, and Ruh's proposals with one-person approval. Uses the
 * shared PG_CLIENT (global), BRIDGE_DB (global, BridgeModule), CoaService (ProductionModule) and
 * ShelfModule's layout + pick-light services.
 */
import { Module } from '@nestjs/common';
import { ShelfModule } from '../shelf/shelf.module.js';
import { FactorySetupController } from './factory-setup.controller.js';
import { FactoryCatalogueService } from './catalogue.service.js';
import { FactorySetupService } from './setup.service.js';
import { SetupStatusService } from './setup-status.service.js';
import { AlembicDraftsClient } from './alembic-drafts.client.js';

@Module({
  imports: [ShelfModule],
  controllers: [FactorySetupController],
  providers: [FactoryCatalogueService, FactorySetupService, SetupStatusService, AlembicDraftsClient],
})
export class FactorySetupModule {}
