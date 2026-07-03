/**
 * ProcAnalyticsService — the procurement flow's missing analytics + negotiation (scope-freeze
 * M03/M04). All raw-SQL over the shared PG_CLIENT (like the geo/search modules):
 *   - Vendor Rate History: last + historical purchase rates per vendor/material, unioned from
 *     quotation lines and PO lines, so procurement can compare rates over time.
 *   - Vendor Performance: per-vendor PO count, GRN count, QC pass/fail + pass% (QC linked back
 *     through grn → rm_batch → inspection).
 *   - Negotiation: revised-rate + notes + recommendation against a quotation (the flow step
 *     between quotation evaluation and final vendor selection).
 * Reads are permission-gated at the controller to reveal-capable procurement roles; negotiation
 * writes are checked here against the caller's token. Material names shown here are safe because
 * only reveal roles reach these endpoints.
 */
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

const NEG_WRITE_PERM = 'procurement:quotation:write';

@Injectable()
export class ProcAnalyticsService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /** Rate history — quotation + PO lines unioned, newest first. Optional material/vendor filter. */
  async rateHistory(materialId?: string, vendorId?: string, limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select * from (
        select qi.quotation_item_id as "id", 'QUOTATION' as "source",
               q.vendor_id as "vendorId", v.vendor_name as "vendorName",
               qi.material_id as "materialId", m.material_name as "materialName",
               qi.quoted_rate as "rate", q.quotation_date as "asOf"
          from procurement.quotation_items qi
          join procurement.quotations q on q.quotation_id = qi.quotation_id
          left join procurement.vendor_details v on v.vendor_id = q.vendor_id
          left join masterdata.material m on m.material_id = qi.material_id
        union all
        select poi.purchase_order_item_id as "id", 'PURCHASE_ORDER' as "source",
               po.vendor_id as "vendorId", v.vendor_name as "vendorName",
               poi.material_id as "materialId", m.material_name as "materialName",
               poi.rate as "rate", po.order_date as "asOf"
          from procurement.purchase_order_items poi
          join procurement.purchase_order po on po.purchase_order_id = poi.purchase_order_id
          left join procurement.vendor_details v on v.vendor_id = po.vendor_id
          left join masterdata.material m on m.material_id = poi.material_id
      ) h
      where (${materialId ?? null}::uuid is null or h."materialId" = ${materialId ?? null})
        and (${vendorId ?? null}::uuid is null or h."vendorId" = ${vendorId ?? null})
      order by h."asOf" desc nulls last
      limit ${lim}`;
    return { items, nextCursor: null };
  }

  /** Per-vendor performance scorecard: PO/GRN counts + QC pass/fail (+ pass%). */
  async vendorPerformance(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const rows = (await this.sql`
      select v.vendor_id as "vendorId", v.vendor_name as "vendorName", v.vendor_code as "vendorCode",
             (select count(*)::int from procurement.purchase_order po where po.vendor_id = v.vendor_id) as "poCount",
             (select count(*)::int from inventory.grn_master g where g.vendor_id = v.vendor_id) as "grnCount",
             (select count(*)::int from quality.qc_inspections qi
                join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
                join inventory.grn_items gi on gi.grn_item_id = b.grn_item_id
                join inventory.grn_master g on g.grn_id = gi.grn_id
               where g.vendor_id = v.vendor_id and upper(qi.overall_result) in ('ACCEPT','PASS')) as "qcPass",
             (select count(*)::int from quality.qc_inspections qi
                join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
                join inventory.grn_items gi on gi.grn_item_id = b.grn_item_id
                join inventory.grn_master g on g.grn_id = gi.grn_id
               where g.vendor_id = v.vendor_id and upper(qi.overall_result) in ('REJECT','FAIL')) as "qcFail"
        from procurement.vendor_details v
       order by v.vendor_name asc
       limit ${lim}`) as Array<Record<string, unknown>>;
    const items = rows.map((r) => {
      const pass = Number(r.qcPass || 0);
      const fail = Number(r.qcFail || 0);
      const total = pass + fail;
      return { ...r, qcPassPct: total ? Math.round((pass / total) * 100) : null };
    });
    return { items, nextCursor: null };
  }

  /* ── negotiation ────────────────────────────────────────────────────── */

  async listNegotiations(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select n.vendor_negotiation_id as "vendorNegotiationId", n.quotation_id as "quotationId",
             q.quotation_number as "quotationNumber", n.vendor_id as "vendorId", v.vendor_name as "vendorName",
             n.material_id as "materialId", m.material_name as "materialName",
             n.original_rate as "originalRate", n.revised_rate as "revisedRate",
             n.notes as "notes", n.recommendation as "recommendation", n.status as "status"
        from procurement.vendor_negotiation n
        left join procurement.quotations q on q.quotation_id = n.quotation_id
        left join procurement.vendor_details v on v.vendor_id = n.vendor_id
        left join masterdata.material m on m.material_id = n.material_id
       order by n.created_dt desc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  async createNegotiation(body: Record<string, unknown>, principal: AuthPrincipal) {
    if (!(principal.permissions || []).includes(NEG_WRITE_PERM)) {
      throw new ForbiddenException(`Missing permission ${NEG_WRITE_PERM}`);
    }
    const g = (k: string): string | null => {
      const v = body[k];
      return v == null || v === '' ? null : String(v);
    };
    const num = g;
    const rows = (await this.sql`
      insert into procurement.vendor_negotiation
        (vendor_negotiation_id, quotation_id, vendor_id, material_id, original_rate, revised_rate,
         notes, recommendation, status, created_by, updated_by)
      values (${randomUUID()}, ${g('quotationId')}, ${g('vendorId')}, ${g('materialId')},
              ${num('originalRate')}, ${num('revisedRate')}, ${g('notes')},
              ${g('recommendation')}, 'ACTIVE', ${principal.userId}, ${principal.userId})
      returning vendor_negotiation_id as "vendorNegotiationId", revised_rate as "revisedRate",
                recommendation as "recommendation", status as "status"`) as Array<Record<string, unknown>>;
    return rows[0];
  }
}
