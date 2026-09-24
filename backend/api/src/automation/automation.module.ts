/**
 * AutomationModule — G3: the factory-side deterministic automation layer. Composition root for
 * the five rules (backend/api/src/automation/*), each an idempotent, exactly-once consumer of
 * the existing outbox mechanism (or, for the alerts rule, a time/threshold scan) — no new
 * broker, reusing `<schema>.outbox` + the shared `PG_CLIENT`, the same pattern
 * ConsumptionService/EmailNotifierService/BridgeRelayService already establish. Runs in the
 * `worker` process alongside those services (see worker.module.ts).
 */
import { Module } from '@nestjs/common';
import { MaterialShortageService } from './material-shortage.service.js';
import { QuarantineIntakeService } from './quarantine-intake.service.js';
import { IncomingQcOutcomeService } from './incoming-qc-outcome.service.js';
import { PackagingReleaseService } from './packaging-release.service.js';
import { AutomationAlertsService } from './alerts.service.js';

@Module({
  providers: [
    MaterialShortageService,
    QuarantineIntakeService,
    IncomingQcOutcomeService,
    PackagingReleaseService,
    AutomationAlertsService,
  ],
})
export class AutomationModule {}
