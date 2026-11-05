/**
 * PolicyModule (PROD-A-1) — the shared rules engine. Exported so every lane's module can inject
 * PolicyService and call evaluate(key, ctx, at?).
 */
import { Module } from '@nestjs/common';
import { PolicyController } from './policy.controller.js';
import { PolicyService } from './policy.service.js';

@Module({
  controllers: [PolicyController],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
