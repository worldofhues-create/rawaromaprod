/**
 * InventoryViewService — Module 6 inventory intelligence the base CRUD lacks. Computes, per batch,
 * the TRUE availability (available = on-hand − reserved − blocked) by netting open reservations
 * against the batch balance, joins the real expiry date + days-to-expiry, and returns everything
 * FEFO-ordered (first-expiry-first-out). Raw SQL over the shared PG_CLIENT; materialId is returned
 * so the global MaterialMaskingInterceptor masks it (+ attaches the alias) for non-reveal roles.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

@Injectable()
export class InventoryViewService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /** Per-batch availability + expiry, FEFO-ordered. Optional materialId filter (for pick selection). */
  async availability(opts: { limit?: number; materialId?: string }) {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 200);
    const where = opts.materialId ? this.sql`where ib.material_id = ${opts.materialId}` : this.sql``;
    const rows = await this.sql`
      select ib.inventory_batch_id       as "inventoryBatchId",
             ib.rm_batch_id              as "rmBatchId",
             ib.material_id              as "materialId",
             ib.storage_location_id      as "storageLocationId",
             ib.uom_id                   as "uomId",
             rb.batch_number             as "batchNumber",
             coalesce(ib.quantity_on_hand, 0)::float as "onHand",
             coalesce(r.reserved, 0)::float          as "reserved",
             qc.overall_result           as "qcStatus",
             (case when upper(coalesce(qc.overall_result,'')) in ('REJECT','HOLD','REWORK') then coalesce(ib.quantity_on_hand, 0) else 0 end)::float as "blocked",
             (case when upper(coalesce(qc.overall_result,'')) in ('REJECT','HOLD','REWORK') then 0
                   else (coalesce(ib.quantity_on_hand, 0) - coalesce(r.reserved, 0)) end)::float as "available",
             rb.expiry_date              as "expiryDate",
             case when rb.expiry_date is not null then (rb.expiry_date - current_date) end as "daysToExpiry",
             coalesce(s.status_code, rb.status) as "status"
      from inventory.inventory_batch ib
      left join inventory.rm_batch_master rb on rb.rm_batch_id = ib.rm_batch_id
      left join inventory.inventory_status_master s on s.inventory_status_id = ib.inventory_status_id
      left join (
        select inventory_batch_id, sum(reserved_qty) reserved
        from inventory.stock_reservation
        where released_dt is null and coalesce(status, 'ACTIVE') <> 'RELEASED'
        group by inventory_batch_id
      ) r on r.inventory_batch_id = ib.inventory_batch_id
      left join (
        select distinct on (rm_batch_id) rm_batch_id, overall_result
        from quality.qc_inspections
        where rm_batch_id is not null
        order by rm_batch_id, created_dt desc
      ) qc on qc.rm_batch_id = ib.rm_batch_id
      ${where}
      order by rb.expiry_date asc nulls last, rb.batch_number asc nulls last
      limit ${limit}`;
    return { items: rows, nextCursor: null };
  }
}
