/**
 * RuhModule — always-on Ruh on the MAIN box (owner rulings 2026-10-06). Imported by AppModule (the
 * panel's routes, the guard interceptor, "Check now") and by WorkerModule (the watch engine's timer
 * and the durable C3 queue's drain — their @Interval timers only fire where the ScheduleModule runs,
 * the worker, exactly like BridgeRelayService). The Vault box never imports it: Ruh's Vault half is
 * cluster-formula's RuhVaultService, reached over the signed internal channel.
 */
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RuhController } from './ruh.controller.js';
import { RuhFactsService } from './ruh-facts.service.js';
import { RuhGuardInterceptor } from './ruh-guard.interceptor.js';
import { RuhGuardsService } from './ruh-guards.service.js';
import { RuhInsightsService } from './ruh-insights.service.js';
import { RuhSettingsService } from './ruh-settings.service.js';
import { RuhSignalService } from './ruh-signal.service.js';
import { RuhWatchService } from './ruh-watch.service.js';

const SERVICES = [RuhSettingsService, RuhSignalService, RuhInsightsService, RuhFactsService, RuhWatchService];

/** HTTP: the panel's routes and the guards on the factory's actions. */
@Module({
  controllers: [RuhController],
  providers: [...SERVICES, RuhGuardsService, { provide: APP_INTERCEPTOR, useClass: RuhGuardInterceptor }],
  exports: [RuhInsightsService, RuhSettingsService],
})
export class RuhModule {}

/** Worker: the watch engine's timer and the C3 queue's drain. */
@Module({ providers: SERVICES })
export class RuhWorkerModule {}
