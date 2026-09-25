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
 *
 * RC7 (item 6): the queue returned at most 200 rows, oldest need-by first, with no paging and no
 * way to ask for one order — on the live demo, past 200 queued requirements, a new one could not
 * be reached at all. It now pages like every other RawProd list (`{ items, nextCursor }`, which the
 * response envelope lifts into `data` + `meta.cursor`; pass `?cursor=` back for the next page) and
 * can be narrowed to one ALEMBIC order (`orderRef`) or one requirement (`alembicRequirementId`).
 * The order is unchanged — need-by, then arrival — with the requirement id as the final tiebreak so
 * the keyset is total; the cursor is the last row's `alembicRequirementId`. Default page 50, max 200,
 * as before.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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

export interface RequirementsQuery {
  unlinkedOnly?: boolean;
  limit?: number;
  /** The `alembicRequirementId` of the previous page's last row (that page's `nextCursor`). */
  cursor?: string;
  /** Only this ALEMBIC order's requirements (exact order reference). */
  orderRef?: string;
  /** Only this requirement. */
  alembicRequirementId?: string;
}

export interface RequirementsPage {
  items: BridgeRequirementRow[];
  nextCursor: string | null;
}

export const REQUIREMENTS_DEFAULT_LIMIT = 50;
export const REQUIREMENTS_MAX_LIMIT = 200;

@Injectable()
export class RequirementsQueueService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /** One page of the queue, oldest need first. */
  async page(opts: RequirementsQuery = {}): Promise<RequirementsPage> {
    const asked = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : REQUIREMENTS_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(asked, 1), REQUIREMENTS_MAX_LIMIT);
    const unlinkedOnly = opts.unlinkedOnly === true;
    const orderRef = opts.orderRef ?? null;
    const requirementId = opts.alembicRequirementId ?? null;

    // The cursor names the previous page's last row; the next page starts strictly after it in the
    // same (need-by, arrival, id) order. Its keys are compared IN SQL, against the row itself: sent
    // back as parameters they would pass through a JS Date and lose their microseconds, and every
    // row created in the same transaction as the cursor row would be served again.
    const cursor = opts.cursor ?? null;
    if (cursor) {
      const [row] = await this.sql`select 1 from bridge.production_requirement where alembic_requirement_id = ${cursor}::uuid`;
      if (!row) throw new BadRequestException('cursor does not name a queued requirement');
    }

    const rows = (await this.sql`
      select alembic_requirement_id::text as "alembicRequirementId",
             order_ref as "orderRef", mapped_sku as "mappedSku",
             qty::text as qty, uom, pack_size as "packSize",
             needed_by as "neededBy", priority,
             lifecycle_status as "lifecycleStatus", status_reason as "statusReason",
             production_order_id::text as "productionOrderId", created_dt as "createdDt"
        from bridge.production_requirement
       where (${unlinkedOnly} = false or production_order_id is null)
         and (${orderRef}::text is null or order_ref = ${orderRef}::text)
         and (${requirementId}::uuid is null or alembic_requirement_id = ${requirementId}::uuid)
         ${cursor
           ? this.sql`and (coalesce(needed_by, 'infinity'::timestamptz), created_dt, alembic_requirement_id)
                        > (select coalesce(c.needed_by, 'infinity'::timestamptz), c.created_dt, c.alembic_requirement_id
                             from bridge.production_requirement c where c.alembic_requirement_id = ${cursor}::uuid)`
           : this.sql``}
       -- A requirement with no need-by date sorts last, where order by needed_by asc always put it.
       order by coalesce(needed_by, 'infinity'::timestamptz) asc, created_dt asc, alembic_requirement_id asc
       limit ${limit + 1}
    `) as unknown as BridgeRequirementRow[];

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : Array.from(rows);
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.alembicRequirementId : null };
  }

  /** The first page's rows only — the queue's original contract, kept for in-process callers. */
  async list(opts: RequirementsQuery = {}): Promise<BridgeRequirementRow[]> {
    return (await this.page(opts)).items;
  }
}
