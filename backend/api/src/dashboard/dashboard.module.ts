/**
 * DashboardModule — app-level, cross-cluster read. Uses the kernel's shared `PG_CLIENT` pool
 * (global) to aggregate across every schema in one place. No new DB token, no writes.
 */
import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
