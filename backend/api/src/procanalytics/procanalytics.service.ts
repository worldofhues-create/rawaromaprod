/**
 * ProcAnalyticsService — the procurement flow's analytics (scope-freeze M03/M04). All raw-SQL
 * over the shared PG_CLIENT (like the geo/search modules):
 *   - Vendor Rate History: last + historical purchase rates per vendor/material, unioned from
 *     quotation lines and PO lines, so procurement can compare rates over time. REAL — reads
 *     only dictionary tables (procurement.quotation_items/quotations/purchase_order_items/
 *     purchase_order, procurement.vendor_details, masterdata.material).
 *   - Vendor Performance: per-vendor PO count, GRN count, QC pass/fail + pass% (QC linked back
 *     through grn → rm_batch → inspection). REAL — dictionary tables only.
 *   - QC-rejected GRNs / vendor ledger / replacement PO: REAL — dictionary tables only.
 *   - Negotiation + vendor dispatch (RP-PROC-007) + approval matrix + advance payments
 *     (lane F5, RP-DEADTABLES): NOT AVAILABLE. All four used to query/insert
 *     procurement.vendor_negotiation / procurement.vendor_dispatch / iam.approval_matrix /
 *     procurement.po_advance_payment — tables that exist in NEITHER their owning package (the
 *     only source `pnpm db:push` draws each schema from, per scripts/db-schema-groups.ts) NOR
 *     the Phase-1A Data Dictionary (docs/PHASE1A_SCHEMA_PLAN.md's table list). Any real/dev
 *     database would 500 with "relation does not exist" the instant these ran — dead calls
 *     dressed up as working ones. Per CLAUDE.md C3 (no destructive migration; additive schema
 *     only if the dictionary process permits it), these now throw an honest
 *     NotImplementedException instead of crashing or fabricating rows — see
 *     listNegotiations/createNegotiation, listVendorDispatches/createVendorDispatch,
 *     approvalMatrix, and listAdvancePayments/createAdvancePayment below for what unblocking
 *     each needs.
 * Reads are permission-gated at the controller to reveal-capable procurement roles; every write
 * is now ALSO permission-gated at the controller (previously service-only checks on 4 POST
 * routes — the controller had no @Permissions decorator, so PermissionsGuard let any
 * authenticated user reach the handler and rely solely on the in-service check; guards added for
 * defense-in-depth and consistency with the rest of the codebase's write routes).
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
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

  /**
   * Approval matrix — the governance table (who creates / submits / approves / final authority /
   * auto-approval) for every transaction, per the owner's spec. NOT AVAILABLE: this used to query
   * `iam.approval_matrix` — a table that does NOT exist in @core/data-iam or @ra/data-org (the
   * only sources `pnpm db:push` draws the `iam` schema from, per scripts/db-schema-groups.ts) and
   * is not in the Phase-1A Data Dictionary. Any real/dev database would 500 with "relation
   * iam.approval_matrix does not exist" the instant this ran. Honest "not available" instead of a
   * crash or fabricated data — see web/app.js's loadView, which surfaces this message verbatim.
   * Unblocking it needs: `approval_matrix` added to the Phase-1A dictionary + @ra/data-org (or
   * @core/data-iam) schema (columns as queried below), then db:push.
   */
  async approvalMatrix(_limit = 200): Promise<never> {
    throw new NotImplementedException(
      'Approval matrix is not available: its backing table (iam.approval_matrix) was never added to the Phase-1A Data Dictionary or @core/data-iam / @ra/data-org schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }

  /* ── vendor dispatch (scope-freeze step 15) ────────────────────────── */

  /**
   * RP-PROC-007: this used to run `select ... from procurement.vendor_dispatch` — a table that
   * does NOT exist anywhere in the real schema pipeline. `procurement.vendor_dispatch` is not
   * defined in @ra/data-procurement (the only source db:push draws the `procurement` schema
   * from, per scripts/db-schema-groups.ts) and is not in the Phase-1A Data Dictionary's table
   * list (docs/PHASE1A_SCHEMA_PLAN.md). Any real or dev database would 500 with "relation
   * procurement.vendor_dispatch does not exist" the moment this ran — a dead call dressed up as
   * a working one. Per CLAUDE.md C3 (no destructive migration; additive schema only if the
   * dictionary process permits it — report if locked), a new table is NOT added here. This is an
   * honest "not available" instead of a crash or fabricated data; web/app.js's loadView surfaces
   * this message verbatim rather than showing a misleading "No records yet".
   * Unblocking it needs: `vendor_dispatch` added to the Phase-1A dictionary + @ra/data-procurement
   * schema (columns as queried below), then db:push.
   */
  async listVendorDispatches(_limit = 200): Promise<never> {
    throw new NotImplementedException(
      'Vendor dispatch tracking is not available: its backing table (procurement.vendor_dispatch) was never added to the Phase-1A Data Dictionary or @ra/data-procurement schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }

  async createVendorDispatch(_body: Record<string, unknown>, principal: AuthPrincipal): Promise<never> {
    if (!(principal.permissions || []).includes('procurement:purchase_order:read')) {
      throw new ForbiddenException('Missing permission procurement:purchase_order:read');
    }
    throw new NotImplementedException(
      'Vendor dispatch tracking is not available: its backing table (procurement.vendor_dispatch) was never added to the Phase-1A Data Dictionary or @ra/data-procurement schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }

  /* ── advance payment (scope-freeze step 13) ────────────────────────── */

  /**
   * NOT AVAILABLE: this used to query/insert `procurement.po_advance_payment` — a table that does
   * NOT exist in @ra/data-procurement (db:push's only source for the `procurement` schema) or the
   * Phase-1A Data Dictionary. Any real/dev database would 500 with "relation
   * procurement.po_advance_payment does not exist". Honest "not available" instead of a crash or
   * fabricated data. Unblocking it needs: `po_advance_payment` added to the Phase-1A dictionary +
   * @ra/data-procurement schema (columns as queried below), then db:push.
   */
  async listAdvancePayments(_limit = 200): Promise<never> {
    throw new NotImplementedException(
      'Advance payments are not available: their backing table (procurement.po_advance_payment) was never added to the Phase-1A Data Dictionary or @ra/data-procurement schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }

  async createAdvancePayment(_body: Record<string, unknown>, principal: AuthPrincipal): Promise<never> {
    if (!(principal.permissions || []).includes('procurement:purchase_order:write')) {
      throw new ForbiddenException('Missing permission procurement:purchase_order:write');
    }
    throw new NotImplementedException(
      'Advance payments are not available: their backing table (procurement.po_advance_payment) was never added to the Phase-1A Data Dictionary or @ra/data-procurement schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }

  /* ── negotiation ────────────────────────────────────────────────────── */

  /**
   * RP-PROC-007: same defect as listVendorDispatches above — `procurement.vendor_negotiation`
   * does not exist in @ra/data-procurement or the Phase-1A Data Dictionary, so this call would
   * 500 against any real database. Honest "not available" instead of a crash or fake rows.
   */
  async listNegotiations(_limit = 200): Promise<never> {
    throw new NotImplementedException(
      'Vendor negotiation tracking is not available: its backing table (procurement.vendor_negotiation) was never added to the Phase-1A Data Dictionary or @ra/data-procurement schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }

  /* ── FAIL-branch tail (scope-freeze M05 rejection loop) ─────────────── */

  /** GRNs that failed QC or carry rejected/short/damaged lines — the settlement picker's source
   * (FAIL-01) so a credit note is raised against the correct rejected batch, with QC context. */
  async qcRejectedGrns(limit = 200) {
    const lim = Math.min(Math.max(1, limit), 500);
    // Enriched with the failed QC result + the batch numbers so the settlement is raised against
    // the correct batch/GRN with visible context (FAIL-01). The picker label reads
    // "GRN · vendor · QC REJECT · batch F24-…" — and degrades to "(no vendor)" rather than "?".
    const items = await this.sql`
      select t.*,
             coalesce(t."grnNumber",'') || ' · ' || coalesce(t."vendorName",'(no vendor)') ||
             case when t."qcResult" is not null then ' · QC ' || t."qcResult" else '' end ||
             case when t."batchNumbers" is not null then ' · batch ' || t."batchNumbers" else '' end as "label"
        from (
          select g.grn_id as "grnId", g.grn_number as "grnNumber", g.purchase_order_id as "purchaseOrderId",
                 po.po_number as "poNumber", g.vendor_id as "vendorId", v.vendor_name as "vendorName",
                 (select string_agg(distinct upper(qi.overall_result), ', ')
                    from quality.qc_inspections qi
                    join inventory.rm_batch_master b on b.rm_batch_id = qi.rm_batch_id
                    join inventory.grn_items gi2 on gi2.grn_item_id = b.grn_item_id
                   where gi2.grn_id = g.grn_id and upper(qi.overall_result) in ('REJECT','FAIL')) as "qcResult",
                 (select string_agg(distinct b.batch_number, ', ')
                    from inventory.rm_batch_master b
                    join inventory.grn_items gi3 on gi3.grn_item_id = b.grn_item_id
                   where gi3.grn_id = g.grn_id) as "batchNumbers"
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
           limit ${lim}
        ) t`;
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

  async createNegotiation(_body: Record<string, unknown>, principal: AuthPrincipal): Promise<never> {
    if (!(principal.permissions || []).includes(NEG_WRITE_PERM)) {
      throw new ForbiddenException(`Missing permission ${NEG_WRITE_PERM}`);
    }
    throw new NotImplementedException(
      'Vendor negotiation tracking is not available: its backing table (procurement.vendor_negotiation) was never added to the Phase-1A Data Dictionary or @ra/data-procurement schema, so it does not exist in any real database. Ask the data team to add it to the dictionary before this feature can go live.',
    );
  }
}
