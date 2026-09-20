/**
 * ClusterProcurementModule — the RAW AROMACHEM procurement cluster (procurement schema).
 * Mints its own `PROCUREMENT_DB` Drizzle client off the shared `PG_CLIENT` pool (bound to
 * the @ra/data-procurement schema barrel), wires the six CRUD feature services + their
 * controllers and the PR/PO document flows, and exports the `PROCUREMENT_LOOKUP` cold-read
 * port. Document flows write dict history/approval rows + (PO issue) a `procurement.po.issued`
 * outbox event drained by the shared OutboxPublisher.
 */
import { Global, Module } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { VendorController } from './vendor/vendor.controller.js';
import { VendorService } from './vendor/vendor.service.js';
import { RequirementController } from './requirement/requirement.controller.js';
import { RequirementService } from './requirement/requirement.service.js';
import { RfqController } from './rfq/rfq.controller.js';
import { RfqService } from './rfq/rfq.service.js';
import { PoController } from './po/po.controller.js';
import { PoService } from './po/po.service.js';
import { CreditController } from './credit/credit.controller.js';
import { CreditService } from './credit/credit.service.js';
import { ProcurementLookupService } from './procurement-lookup.service.js';
import {
  PROCUREMENT_DB,
  drizzle,
  procurementSchema,
} from './cluster-procurement.tokens.js';
import { PROCUREMENT_LOOKUP } from './public-api.js';

@Global()
@Module({
  controllers: [
    VendorController,
    RequirementController,
    RfqController,
    PoController,
    CreditController,
  ],
  providers: [
    {
      provide: PROCUREMENT_DB,
      inject: [PG_CLIENT],
      useFactory: (client: Sql) => drizzle(client, { schema: procurementSchema }),
    },
    VendorService,
    RequirementService,
    RfqService,
    PoService,
    CreditService,
    ProcurementLookupService,
    { provide: PROCUREMENT_LOOKUP, useExisting: ProcurementLookupService },
  ],
  exports: [PROCUREMENT_DB, PROCUREMENT_LOOKUP],
})
export class ClusterProcurementModule {}
