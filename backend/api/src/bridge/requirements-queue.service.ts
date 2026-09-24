/**
 * RequirementsQueueService — the PLANNER's view of ALEMBIC production requirements that have
 * landed on RawProd (golden journey, lane/j2).
 *
 * `ImporterService` accepts `ProductionRequirementCreated` into `bridge.production_requirement`
 * and `PlanningService.createOrder` links a production order to one via
 * `alembicRequirementId` — but until this service nothing in the product EXPOSED those rows,
 * so a planner had no way to learn the id to link against short of reading the table with SQL.
 * This is the read half of that loop: the incoming queue, oldest need first, with whether each
 * requirement already has a production order.
 *
 * Read-only, no plaintext of any kind: order ref, the mapped factory SKU, quantity/UoM, need-by
 * date, lifecycle status — exactly the fields ALEMBIC itself sent. Gated on
 * `production:production_order:read` (the same permission that reads the orders these rows
 * become).
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

export interface BridgeRequirementRow {
  alembicRequirementId: string;
  orderRef: string;
  mappedSku: string;
  qty: string;
  uom: string;
  packSize: string | null;
  neededBy: string;
  priority: string;
  lifecycleStatus: string;
  statusReason: string | null;
  productionOrderId: string | null;
  createdDt: string;
}

@Injectable()
export class RequirementsQueueService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async list(opts: { unlinkedOnly?: boolean; limit?: number } = {}): Promise<BridgeRequirementRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const unlinkedOnly = opts.unlinkedOnly === true;
    return (await this.sql`
      select alembic_requirement_id::text as "alembicRequirementId",
             order_ref as "orderRef", mapped_sku as "mappedSku",
             qty::text as qty, uom, pack_size as "packSize",
             needed_by as "neededBy", priority,
             lifecycle_status as "lifecycleStatus", status_reason as "statusReason",
             production_order_id::text as "productionOrderId", created_dt as "createdDt"
        from bridge.production_requirement
       where (${unlinkedOnly} = false or production_order_id is null)
       order by needed_by asc, created_dt asc
       limit ${limit}
    `) as unknown as BridgeRequirementRow[];
  }
}
