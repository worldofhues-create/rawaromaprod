/**
 * HealthModule — exposes `/health`. Depends on the (global) DrizzleModule for `PG_CLIENT`.
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
