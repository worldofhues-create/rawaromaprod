/**
 * PolicyModule (PROD-A-1) — the shared rules engine. Exported so every lane's module can inject
 * PolicyService and call evaluate(key, ctx, at?).
 */
import { Module } from '@nestjs/common';
import { PolicyController } from './policy.controller.js';
import { PolicyService } from './policy.service.js';
import { FactoryRulesStateService } from './factory-rules-state.js';

@Module({
  controllers: [PolicyController],
  // PROM-6: factory.rules.state at start and daily (factory-rules-state.ts).
  providers: [PolicyService, FactoryRulesStateService],
  exports: [PolicyService],
})
export class PolicyModule {}
