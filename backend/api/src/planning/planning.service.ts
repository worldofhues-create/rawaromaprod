/**
 * PlanningService — M04 Stock Planning intelligence the base CRUD lacks. Per material it nets
 * on-hand − open-reservations = available, against open demand (open stock_requirements), and
 * computes the SHORTAGE = max(0, required − available). This turns "raise a PR from memory" into
 * a system-driven reorder suggestion (the Executive-Vision "missed order / late replenishment"
 * pain). materialId is returned so the masking interceptor applies; code/name are material-master
 * fields (visible to material:read holders) needed to act on the suggestion.
 */
import { netQty, notTotalled, type Netted } from '@core/data-kernel';
import { availableIn, stockPosition, unitOf } from '../inventory-view/stock-position.js';
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
    //
    // STOCK2-3: on-hand, reserved and open requirements each add up in their own units, so they are
    // netted exactly in the material's unit. A material whose stock cannot be totalled shows no
    // figures and a note, and sorts first: it is the row nobody can judge from a number.
    const rows = await this.sql<{ materialId: string; materialCode: string | null; materialName: string | null; level: string; uom: string | null; suggestedVendor: string | null }[]>`
      select m.material_id::text as "materialId",
             m.material_code as "materialCode",
             m.material_name as "materialName",
             coalesce(m.reorder_level, m.min_stock, 0)::text as level,
             mu.uom_code as uom,
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
      left join platform.uom_master mu on mu.uom_id = m.uom_id
      where coalesce(m.reorder_level, m.min_stock, 0) > 0`;
    const ids = rows.map((r) => r.materialId);
    const positions = await stockPosition(this.sql, ids);
    const open = await this.sql<{ material_id: string; uom: string | null; qty: string }[]>`
      select sr.material_id::text, u.uom_code as uom, sum(sr.required_qty)::text as qty
        from procurement.stock_requirement sr left join platform.uom_master u on u.uom_id = sr.uom_id
       where sr.material_id = any(${ids}::uuid[])
         and (sr.status is null or upper(sr.status) <> 'CLOSED')
         and upper(coalesce(sr.requirement_source, '')) <> 'REORDER_SUGGESTION'
       group by 1, 2`;
    const items = rows.map(({ level, ...r }) => {
      const p = positions.get(r.materialId);
      const uom = r.uom ?? unitOf(p);
      const reqs = open.filter((o) => o.material_id === r.materialId);
      const onHand = netQty(p?.onHand ?? [], [], uom), reserved = netQty(p?.reserved ?? [], [], uom), available = availableIn(p, uom);
      const short = netQty([{ qty: level, uom }, ...(p?.reserved ?? [])], p?.onHand ?? [], uom);
      const openReq = netQty(reqs, [], uom);
      const bad = [onHand, reserved, available, short].find((n) => 'refused' in n);
      const fig = (n: Netted) => ('refused' in n ? null : Number(n.qty));
      const blank = bad ? null : undefined;
      return {
        ...r, uom, onHand: blank === null ? null : fig(onHand), reserved: blank === null ? null : fig(reserved), available: blank === null ? null : fig(available),
        reorderLevel: Number(level), openReq: fig(openReq),
        shortage: blank === null ? null : Math.max(0, fig(short) ?? 0),
        unitNote: bad && 'refused' in bad ? notTotalled(bad) : null,
      };
    });
    const rank = (x: { shortage: number | null }) => (x.shortage === null ? Infinity : x.shortage);
    items.sort((a, b) => rank(b) - rank(a) || String(a.materialCode).localeCompare(String(b.materialCode)));
    return { items: items.slice(0, lim), nextCursor: null };
  }
}
