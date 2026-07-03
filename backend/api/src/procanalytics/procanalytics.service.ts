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
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

const NEG_WRITE_PERM = 'procurement:quotation_items:write';

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

  /** Approval matrix — the governance table (who creates / submits / approves / final authority /
   * auto-approval) for every transaction, per the owner's spec. Reference data, auth-only. */
  async approvalMatrix(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select approval_matrix_id as "approvalMatrixId", module, transaction as "transaction",
             created_by as "createdBy", submitted_to as "submittedTo", approved_by as "approvedBy",
             final_authority as "finalAuthority", auto_approval as "autoApproval", remarks
        from iam.approval_matrix
       order by ord asc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  /* ── vendor dispatch (scope-freeze step 15) ────────────────────────── */

  async listVendorDispatches(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select vd.vendor_dispatch_id as "vendorDispatchId", vd.purchase_order_id as "purchaseOrderId",
             po.po_number as "poNumber", v.vendor_name as "vendorName",
             vd.dispatch_date as "dispatchDate", vd.transporter as "transporter",
             vd.docket_number as "docketNumber", vd.vehicle_number as "vehicleNumber", vd.status as "status"
        from procurement.vendor_dispatch vd
        left join procurement.purchase_order po on po.purchase_order_id = vd.purchase_order_id
        left join procurement.vendor_details v on v.vendor_id = po.vendor_id
       order by vd.created_dt desc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  async createVendorDispatch(body: Record<string, unknown>, principal: AuthPrincipal) {
    if (!(principal.permissions || []).includes('procurement:purchase_order:read')) {
      throw new ForbiddenException('Missing permission procurement:purchase_order:read');
    }
    const g = (k: string): string | null => {
      const v = body[k];
      return v == null || v === '' ? null : String(v);
    };
    if (!g('purchaseOrderId')) throw new BadRequestException('purchaseOrderId is required');
    const rows = (await this.sql`
      insert into procurement.vendor_dispatch (vendor_dispatch_id, purchase_order_id, dispatch_date, transporter, docket_number, vehicle_number, status, created_by, updated_by)
      values (${randomUUID()}, ${g('purchaseOrderId')}, ${g('dispatchDate')}, ${g('transporter')}, ${g('docketNumber')}, ${g('vehicleNumber')}, 'DISPATCHED', ${principal.userId}, ${principal.userId})
      returning vendor_dispatch_id as "vendorDispatchId", status as "status"`) as Array<Record<string, unknown>>;
    return rows[0];
  }

  /* ── advance payment (scope-freeze step 13) ────────────────────────── */

  async listAdvancePayments(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select ap.po_advance_payment_id as "poAdvancePaymentId", ap.purchase_order_id as "purchaseOrderId",
             po.po_number as "poNumber", v.vendor_name as "vendorName",
             ap.amount as "amount", ap.payment_date as "paymentDate", ap.reference as "reference", ap.status as "status"
        from procurement.po_advance_payment ap
        left join procurement.purchase_order po on po.purchase_order_id = ap.purchase_order_id
        left join procurement.vendor_details v on v.vendor_id = po.vendor_id
       order by ap.created_dt desc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  async createAdvancePayment(body: Record<string, unknown>, principal: AuthPrincipal) {
    if (!(principal.permissions || []).includes('procurement:purchase_order:write')) {
      throw new ForbiddenException('Missing permission procurement:purchase_order:write');
    }
    const g = (k: string): string | null => {
      const v = body[k];
      return v == null || v === '' ? null : String(v);
    };
    if (!g('purchaseOrderId')) throw new BadRequestException('purchaseOrderId is required');
    const rows = (await this.sql`
      insert into procurement.po_advance_payment (po_advance_payment_id, purchase_order_id, amount, payment_date, reference, status, created_by, updated_by)
      values (${randomUUID()}, ${g('purchaseOrderId')}, ${g('amount')}, ${g('paymentDate')}, ${g('reference')}, 'PAID', ${principal.userId}, ${principal.userId})
      returning po_advance_payment_id as "poAdvancePaymentId", amount as "amount", status as "status"`) as Array<Record<string, unknown>>;
    return rows[0];
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

  /* ── FAIL-branch tail (scope-freeze M05 rejection loop) ─────────────── */

  /** GRNs that failed QC or carry rejected/short/damaged lines — the settlement picker's source
   * (FAIL-01) so a credit note is raised against the correct rejected batch, with QC context. */
  async qcRejectedGrns(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const items = await this.sql`
      select g.grn_id as "grnId", g.grn_number as "grnNumber", g.purchase_order_id as "purchaseOrderId",
             po.po_number as "poNumber", g.vendor_id as "vendorId", v.vendor_name as "vendorName",
             (select string_agg(distinct upper(qi.overall_result), ', ')
                from quality.qc_inspections qi
                join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
                join inventory.grn_items gi2 on gi2.grn_item_id = b.grn_item_id
               where gi2.grn_id = g.grn_id and upper(qi.overall_result) in ('REJECT','FAIL')) as "qcResult",
             coalesce(g.grn_number,'') || ' · ' || coalesce(v.vendor_name,'?') as "label"
        from inventory.grn_master g
        left join procurement.purchase_order po on po.purchase_order_id = g.purchase_order_id
        left join procurement.vendor_details v on v.vendor_id = g.vendor_id
       where exists (select 1 from quality.qc_inspections qi
                       join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
                       join inventory.grn_items gi on gi.grn_item_id = b.grn_item_id
                      where gi.grn_id = g.grn_id and upper(qi.overall_result) in ('REJECT','FAIL'))
          or exists (select 1 from inventory.grn_items gi
                      where gi.grn_id = g.grn_id and (coalesce(gi.rejected_qty,0) > 0 or coalesce(gi.damaged_qty,0) > 0 or gi.variance_type in ('SHORT','DAMAGED')))
       order by g.grn_id desc
       limit ${lim}`;
    return { items, nextCursor: null };
  }

  /** Per-vendor ledger: total PO value (debit) vs total credit notes, with the net balance —
   * so a credit note is visibly adjusted against the vendor (FAIL-02). */
  async vendorLedger(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    const rows = (await this.sql`
      select v.vendor_id as "vendorId", v.vendor_name as "vendorName", v.vendor_code as "vendorCode",
             (select coalesce(sum(po.total_amount),0)::float8 from procurement.purchase_order po where po.vendor_id = v.vendor_id) as "poTotal",
             (select count(*)::int from procurement.vendor_credit_note cn where cn.vendor_id = v.vendor_id) as "creditNotes",
             (select coalesce(sum(cn.amount),0)::float8 from procurement.vendor_credit_note cn where cn.vendor_id = v.vendor_id) as "creditTotal"
        from procurement.vendor_details v
       order by v.vendor_name asc
       limit ${lim}`) as Array<Record<string, unknown>>;
    const items = rows.map((r) => ({
      ...r,
      netBalance: Number((Number(r.poTotal || 0) - Number(r.creditTotal || 0)).toFixed(2)),
    }));
    return { items, nextCursor: null };
  }

  /** Generate a replacement PO from a rejected/short GRN, linked to the original PO (FAIL-03/04).
   * Copies each rejected/short/damaged line's shortfall (ordered − accepted, else rejected/damaged)
   * into a fresh DRAFT PO for the same vendor, stamping replacement_of_po_id. */
  async createReplacementPo(grnId: string, principal: AuthPrincipal) {
    if (!(principal.permissions || []).includes('procurement:purchase_order:write')) {
      throw new ForbiddenException('Missing permission procurement:purchase_order:write');
    }
    const grn = (await this.sql`
      select g.grn_id, g.purchase_order_id, g.vendor_id, po.currency_id, po.delivery_location_id
        from inventory.grn_master g
        left join procurement.purchase_order po on po.purchase_order_id = g.purchase_order_id
       where g.grn_id = ${grnId} limit 1`)[0] as Record<string, unknown> | undefined;
    if (!grn) throw new BadRequestException(`GRN ${grnId} not found`);

    const lines = (await this.sql`
      select gi.material_id, gi.uom_id, gi.ordered_qty, gi.accepted_qty, gi.rejected_qty, gi.damaged_qty, gi.variance_type,
             poi.rate
        from inventory.grn_items gi
        left join procurement.purchase_order_items poi on poi.purchase_order_item_id = gi.purchase_order_item_id
       where gi.grn_id = ${grnId}
         and (coalesce(gi.rejected_qty,0) > 0 or coalesce(gi.damaged_qty,0) > 0 or gi.variance_type in ('SHORT','DAMAGED'))`) as Array<Record<string, unknown>>;
    if (!lines.length) throw new BadRequestException('This GRN has no rejected/short/damaged lines to replace');

    const poId = randomUUID();
    const poNumber = 'PO-' + new Date().toISOString().slice(0, 7).replace('-', '') + '-R' + String(Date.now()).slice(-5);
    let total = 0;
    const items = lines.map((l) => {
      const ordered = Number(l.ordered_qty ?? 0);
      const accepted = Number(l.accepted_qty ?? 0);
      const rejected = Number(l.rejected_qty ?? 0);
      const damaged = Number(l.damaged_qty ?? 0);
      // shortfall to re-order = the gap vs ordered, else what was rejected/damaged.
      let qty = ordered > 0 ? ordered - accepted : rejected + damaged;
      if (!(qty > 0)) qty = rejected + damaged || 1;
      const rate = Number(l.rate ?? 0);
      const amount = Number.isFinite(qty * rate) ? qty * rate : 0;
      total += amount;
      return { materialId: l.material_id, uomId: l.uom_id, qty, rate, amount };
    });

    await this.sql`
      insert into procurement.purchase_order (purchase_order_id, po_number, vendor_id, currency_id, delivery_location_id,
        replacement_of_po_id, order_date, total_amount, status, created_by, updated_by, created_dt, updated_dt)
      values (${poId}, ${poNumber}, ${grn.vendor_id as string ?? null}, ${grn.currency_id as string ?? null},
              ${grn.delivery_location_id as string ?? null}, ${grn.purchase_order_id as string ?? null},
              now(), ${String(total)}, 'DRAFT', ${principal.userId}, ${principal.userId}, now(), now())`;
    for (const it of items) {
      await this.sql`
        insert into procurement.purchase_order_items (purchase_order_item_id, purchase_order_id, material_id, ordered_qty, uom_id, rate, amount, status, created_by, updated_by, created_dt, updated_dt)
        values (${randomUUID()}, ${poId}, ${(it.materialId as string) ?? null}, ${String(it.qty)}, ${(it.uomId as string) ?? null}, ${String(it.rate)}, ${String(it.amount)}, 'ACTIVE', ${principal.userId}, ${principal.userId}, now(), now())`;
    }
    return { purchaseOrderId: poId, poNumber, replacementOfPoId: grn.purchase_order_id, lines: items.length, totalAmount: total };
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
