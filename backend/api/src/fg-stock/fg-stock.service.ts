/**
 * FgStockService — finished-goods available-to-promise (ATP) the base packaging CRUD lacks.
 * FG stock is a DERIVED balance, not a stored on-hand column: for each finished-good batch,
 *   available = produced − dispatched − consumed − reserved (clamped ≥ 0)
 * where produced comes from packaging.finished_good_batch_master, dispatched from
 * sales.dispatch_items, consumed from packaging.finished_goods_batch_consumption, and reserved
 * from packaging.finished_good_reservation (active = released_dt IS NULL). Raw cross-schema SQL
 * over the shared PG_CLIENT (the schema-per-cluster boundary is a read-model join here). Results
 * are FEFO-ordered (first-expiry-first-out). FG batches carry no material_id, so masking is a
 * no-op. Quantities net only within a single batch (each batch has one uom_id).
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

@Injectable()
export class FgStockService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /** Per-FG-batch ATP, FEFO-ordered. Optional productSkuId filter (for a dispatch/reservation picker). */
  async availability(opts: { limit?: number; productSkuId?: string; onlyAvailable?: boolean }) {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 200);
    const skuWhere = opts.productSkuId ? this.sql`fg.product_sku_id = ${opts.productSkuId}` : this.sql`true`;
    const availWhere = opts.onlyAvailable
      ? this.sql`and case when upper(coalesce(qc.overall_result,'')) = 'FAIL' then 0 else greatest(0, coalesce(fg.produced_qty,0) - coalesce(d.dispatched,0) - coalesce(c.consumed,0) - coalesce(r.reserved,0)) end > 0`
      : this.sql``;
    const rows = await this.sql`
      select fg.finished_good_batch_id as "finishedGoodBatchId",
             fg.batch_number           as "batchNumber",
             fg.product_sku_id         as "productSkuId",
             sku.sku_code              as "skuCode",
             pm.product_name           as "productName",
             fg.uom_id                 as "uomId",
             coalesce(fg.produced_qty, 0)::float  as "producedQty",
             coalesce(d.dispatched, 0)::float     as "dispatchedQty",
             coalesce(c.consumed, 0)::float       as "consumedQty",
             coalesce(r.reserved, 0)::float       as "reservedQty",
             qc.overall_result                    as "qcResult",
             (case when upper(coalesce(qc.overall_result,'')) = 'FAIL' then 0
                   else greatest(0, coalesce(fg.produced_qty,0) - coalesce(d.dispatched,0) - coalesce(c.consumed,0) - coalesce(r.reserved,0)) end)::float as "availableQty",
             fg.manufacturing_date     as "manufacturingDate",
             fg.expiry_date            as "expiryDate",
             case when fg.expiry_date is not null then (fg.expiry_date - current_date) end as "daysToExpiry",
             fg.status                 as "status"
      from packaging.finished_good_batch_master fg
      left join packaging.product_sku sku on sku.product_sku_id = fg.product_sku_id
      left join packaging.product_master pm on pm.product_id = sku.product_id
      left join (
        select finished_good_batch_id, sum(dispatched_qty) dispatched
        from sales.dispatch_items
        where coalesce(status, 'ACTIVE') <> 'CANCELLED'
        group by finished_good_batch_id
      ) d on d.finished_good_batch_id = fg.finished_good_batch_id
      left join (
        select finished_good_batch_id, sum(consumed_qty) consumed
        from packaging.finished_goods_batch_consumption
        where coalesce(status, 'ACTIVE') <> 'CANCELLED'
        group by finished_good_batch_id
      ) c on c.finished_good_batch_id = fg.finished_good_batch_id
      left join (
        select finished_good_batch_id, sum(reserved_qty) reserved
        from packaging.finished_good_reservation
        where released_dt is null and coalesce(status, 'ACTIVE') <> 'RELEASED'
        group by finished_good_batch_id
      ) r on r.finished_good_batch_id = fg.finished_good_batch_id
      left join (
        select distinct on (finished_good_batch_id) finished_good_batch_id, overall_result
        from packaging.packaging_qc
        order by finished_good_batch_id, created_dt desc
      ) qc on qc.finished_good_batch_id = fg.finished_good_batch_id
      where ${skuWhere} ${availWhere}
      order by fg.expiry_date asc nulls last, fg.batch_number asc nulls last
      limit ${limit}`;
    return { items: rows, nextCursor: null };
  }

  /** Per-SKU ATP roll-up (sellable stock per SKU across all its batches) — the by-SKU grant view. */
  async bySku(opts: { limit?: number }) {
    const limit = Math.min(Math.max(1, opts.limit ?? 100), 200);
    const rows = await this.sql`
      select sku.product_sku_id as "productSkuId",
             sku.sku_code       as "skuCode",
             pm.product_name    as "productName",
             count(fg.finished_good_batch_id)::int as "batchCount",
             sum(coalesce(fg.produced_qty, 0))::float as "producedQty",
             sum(case when upper(coalesce(qc.overall_result,'')) = 'FAIL' then 0
                      else greatest(0, coalesce(fg.produced_qty,0) - coalesce(d.dispatched,0) - coalesce(c.consumed,0) - coalesce(r.reserved,0)) end)::float as "availableQty"
      from packaging.finished_good_batch_master fg
      join packaging.product_sku sku on sku.product_sku_id = fg.product_sku_id
      left join packaging.product_master pm on pm.product_id = sku.product_id
      left join (
        select finished_good_batch_id, sum(dispatched_qty) dispatched
        from sales.dispatch_items
        where coalesce(status, 'ACTIVE') <> 'CANCELLED'
        group by finished_good_batch_id
      ) d on d.finished_good_batch_id = fg.finished_good_batch_id
      left join (
        select finished_good_batch_id, sum(consumed_qty) consumed
        from packaging.finished_goods_batch_consumption
        where coalesce(status, 'ACTIVE') <> 'CANCELLED'
        group by finished_good_batch_id
      ) c on c.finished_good_batch_id = fg.finished_good_batch_id
      left join (
        select finished_good_batch_id, sum(reserved_qty) reserved
        from packaging.finished_good_reservation
        where released_dt is null and coalesce(status, 'ACTIVE') <> 'RELEASED'
        group by finished_good_batch_id
      ) r on r.finished_good_batch_id = fg.finished_good_batch_id
      left join (
        select distinct on (finished_good_batch_id) finished_good_batch_id, overall_result
        from packaging.packaging_qc
        order by finished_good_batch_id, created_dt desc
      ) qc on qc.finished_good_batch_id = fg.finished_good_batch_id
      group by sku.product_sku_id, sku.sku_code, pm.product_name
      order by "availableQty" desc
      limit ${limit}`;
    return { items: rows, nextCursor: null };
  }
}
