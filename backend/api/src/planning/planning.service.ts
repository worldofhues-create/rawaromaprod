/**
 * PlanningService — M04 Stock Planning intelligence the base CRUD lacks. Per material it nets
 * on-hand − open-reservations = available, against open demand (open stock_requirements), and
 * computes the SHORTAGE = max(0, required − available). This turns "raise a PR from memory" into
 * a system-driven reorder suggestion (the Executive-Vision "missed order / late replenishment"
 * pain). materialId is returned so the masking interceptor applies; code/name are material-master
 * fields (visible to material:read holders) needed to act on the suggestion.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

@Injectable()
export class PlanningService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async reorderSuggestions(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    // Reorder-point logic: shortage = max(0, reorderLevel − available). It compares stock against
    // the material's REORDER LEVEL (a fixed threshold), NOT against open requirements — so raising a
    // requirement never feeds back into the shortage (the old bug that doubled it). "openReq" is shown
    // for context only (how much reorder is already in flight). reorderLevel falls back to min_stock.
    const rows = await this.sql`
      select m.material_id   as "materialId",
             m.material_code as "materialCode",
             m.material_name as "materialName",
             coalesce(oh.onhand, 0)::float   as "onHand",
             coalesce(rs.reserved, 0)::float as "reserved",
             (coalesce(oh.onhand, 0) - coalesce(rs.reserved, 0))::float as "available",
             coalesce(m.reorder_level, m.min_stock, 0)::float as "reorderLevel",
             coalesce(req.required, 0)::float as "openReq",
             greatest(0, coalesce(m.reorder_level, m.min_stock, 0) - (coalesce(oh.onhand, 0) - coalesce(rs.reserved, 0)))::float as "shortage",
             coalesce(
               (select v.vendor_name from procurement.vendor_rm_mapping vm
                  join procurement.vendor_details v on v.vendor_id = vm.vendor_id
                 where vm.material_id = m.material_id and vm.is_preferred = true limit 1),
               (select v.vendor_name from procurement.purchase_order_items poi
                  join procurement.purchase_order po on po.purchase_order_id = poi.purchase_order_id
                  join procurement.vendor_details v on v.vendor_id = po.vendor_id
                 where poi.material_id = m.material_id order by po.order_date desc nulls last limit 1)
             ) as "suggestedVendor"
      from masterdata.material m
      left join (select material_id, sum(quantity_on_hand) onhand from inventory.inventory_batch group by material_id) oh on oh.material_id = m.material_id
      left join (select ib.material_id, sum(r.reserved_qty) reserved
                 from inventory.stock_reservation r
                 join inventory.inventory_batch ib on ib.inventory_batch_id = r.inventory_batch_id
                 where r.released_dt is null group by ib.material_id) rs on rs.material_id = m.material_id
      left join (select material_id, sum(required_qty) required
                 from procurement.stock_requirement
                 where (status is null or upper(status) <> 'CLOSED')
                   and upper(coalesce(requirement_source, '')) <> 'REORDER_SUGGESTION'
                 group by material_id) req on req.material_id = m.material_id
      where coalesce(m.reorder_level, m.min_stock, 0) > 0
      order by shortage desc, m.material_code asc
      limit ${lim}`;
    return { items: rows, nextCursor: null };
  }
}
