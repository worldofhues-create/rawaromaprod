/**
 * RfqService — CRUD over the RFQ + quotation tables (RFQ_MASTER, RFQ_ITEMS,
 * RFQ_VENDOR_MAPPINGS, QUOTATIONS, QUOTATION_ITEMS). quotations + quotation_items record a
 * vendor's response to an RFQ. Create stamps status "ACTIVE" + created_by/updated_by.
 * numeric → String(n); dates stay ISO date strings (date columns). Soft refs are plain uuids.
 */
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import {
  PROCUREMENT_DB,
  procurementSchema,
  type ProcurementDb,
} from '../cluster-procurement.tokens.js';
import type { Page, ListQuery } from '../cluster-procurement.dtos.js';
import type {
  CreateQuotation,
  CreateQuotationItem,
  CreateRfqItem,
  CreateRfqMaster,
  CreateRfqVendorMapping,
  SelectQuotation,
} from '../cluster-procurement.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const { rfqMaster, rfqItems, rfqVendorMappings, quotations, quotationItems } =
  procurementSchema;

@Injectable()
export class RfqService {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  /* ── rfq_master ─────────────────────────────────────────────────────── */

  async createRfqMaster(body: CreateRfqMaster, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(rfqMaster)
          .values({
            rfqNumber: body.rfqNumber ?? null,
            purchaseRequestId: body.purchaseRequestId ?? null,
            rfqDate: body.rfqDate ?? null,
            submissionDeadline: body.submissionDeadline ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listRfqMasters(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with the source PR number so the list shows which RFQ maps to which PR.
    const rows = (await this.db.execute(sql`
      select r.rfq_id as "rfqId", r.rfq_number as "rfqNumber", r.purchase_request_id as "purchaseRequestId",
             pr.pr_number as "prNumber", r.rfq_date as "rfqDate", r.submission_deadline as "submissionDeadline", r.status as "status"
        from procurement.rfq_master r
        left join procurement.purchase_request pr on pr.purchase_request_id = r.purchase_request_id
       ${query.cursor ? sql`where r.rfq_id < ${query.cursor}` : sql``}
       order by r.rfq_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.rfqId as string);
  }

  async getRfqMaster(id: string) {
    return (
      (await this.db.select().from(rfqMaster).where(eq(rfqMaster.rfqId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── rfq_items ──────────────────────────────────────────────────────── */

  async createRfqItem(body: CreateRfqItem, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(rfqItems)
          .values({
            rfqId: body.rfqId ?? null,
            materialId: body.materialId ?? null,
            requiredQty: body.requiredQty != null ? String(body.requiredQty) : null,
            uomId: body.uomId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listRfqItems(query: ListQuery): Promise<Page<typeof rfqItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(rfqItems)
      .where(query.cursor ? lt(rfqItems.rfqItemId, query.cursor) : undefined)
      .orderBy(desc(rfqItems.rfqItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rfqItemId);
  }

  async getRfqItem(id: string) {
    return (
      (await this.db.select().from(rfqItems).where(eq(rfqItems.rfqItemId, id)).limit(1))[0] ??
      null
    );
  }

  /* ── rfq_vendor_mappings ────────────────────────────────────────────── */

  async createRfqVendorMapping(body: CreateRfqVendorMapping, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(rfqVendorMappings)
          .values({
            rfqId: body.rfqId ?? null,
            vendorId: body.vendorId ?? null,
            isSelectedVendor: body.isSelectedVendor ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listRfqVendorMappings(
    query: ListQuery,
  ): Promise<Page<typeof rfqVendorMappings.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(rfqVendorMappings)
      .where(
        query.cursor ? lt(rfqVendorMappings.rfqVendorMappingId, query.cursor) : undefined,
      )
      .orderBy(desc(rfqVendorMappings.rfqVendorMappingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rfqVendorMappingId);
  }

  async getRfqVendorMapping(id: string) {
    return (
      (
        await this.db
          .select()
          .from(rfqVendorMappings)
          .where(eq(rfqVendorMappings.rfqVendorMappingId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── quotations (vendor response) ───────────────────────────────────── */

  async createQuotation(body: CreateQuotation, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(quotations)
          .values({
            rfqId: body.rfqId ?? null,
            vendorId: body.vendorId ?? null,
            quotationNumber: body.quotationNumber ?? null,
            quotationDate: body.quotationDate ?? null,
            validUntilDate: body.validUntilDate ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listQuotations(query: ListQuery): Promise<Page<typeof quotations.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(quotations)
      .where(query.cursor ? lt(quotations.quotationId, query.cursor) : undefined)
      .orderBy(desc(quotations.quotationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.quotationId);
  }

  async getQuotation(id: string) {
    return (
      (
        await this.db
          .select()
          .from(quotations)
          .where(eq(quotations.quotationId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── quotation_items (vendor response lines) ────────────────────────── */

  async createQuotationItem(body: CreateQuotationItem, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(quotationItems)
          .values({
            quotationId: body.quotationId ?? null,
            materialId: body.materialId ?? null,
            quotedQty: body.quotedQty != null ? String(body.quotedQty) : null,
            uomId: body.uomId ?? null,
            quotedRate: body.quotedRate != null ? String(body.quotedRate) : null,
            currencyId: body.currencyId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listQuotationItems(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with quotation number + vendor + material + rate so procurement can compare quotes.
    // Readers (Owner/Procurement) hold material reveal, so the material name is not a masking concern;
    // material_id is still surfaced so the interceptor would mask it for any non-reveal caller.
    const rows = (await this.db.execute(sql`
      select qi.quotation_item_id as "quotationItemId", qi.quotation_id as "quotationId",
             q.quotation_number as "quotationNumber", v.vendor_name as "vendorName",
             qi.material_id as "materialId", m.material_name as "materialName",
             qi.quoted_qty as "quotedQty", qi.quoted_rate as "quotedRate", qi.uom_id as "uomId", qi.status as "status"
        from procurement.quotation_items qi
        left join procurement.quotations q on q.quotation_id = qi.quotation_id
        left join procurement.vendor_details v on v.vendor_id = q.vendor_id
        left join masterdata.material m on m.material_id = qi.material_id
       ${query.cursor ? sql`where qi.quotation_item_id < ${query.cursor}` : sql``}
       order by qi.quotation_item_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.quotationItemId as string);
  }

  async getQuotationItem(id: string) {
    return (
      (
        await this.db
          .select()
          .from(quotationItems)
          .where(eq(quotationItems.quotationItemId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── FLOW: select winning quotation (RFQ → PO gap, RP-PROC-006) ───────── */

  /**
   * POST /v1/quotations/:id/select — the formal "select winning quotation" step that was
   * missing from the RFQ → PO flow: createPurchaseOrder used to accept ANY quotationId with no
   * check that it had actually won the RFQ, so a PO could be raised off a quote nobody chose.
   * This marks exactly one quotation per RFQ as the awarded winner:
   *   - the quotation must belong to a real RFQ (quotation.rfqId not null)
   *   - its vendor must actually be a mapped/invited vendor for that RFQ (rfq_vendor_mappings) —
   *     a quote from a vendor who was never on the RFQ cannot win it
   *   - only ONE quotation per RFQ may ever hold status 'SELECTED' — awarding a second, different
   *     quotation for an RFQ that already has a winner is rejected (409) as a double award;
   *     re-selecting the SAME quotation that already won is a harmless no-op
   * On success, quotations.status → 'SELECTED' and the matching rfq_vendor_mappings row gets
   * is_selected_vendor = true (other vendor mappings for the same RFQ are cleared to false).
   */
  async selectQuotation(id: string, _body: SelectQuotation, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const quotation = (
        await tx.select().from(quotations).where(eq(quotations.quotationId, id)).limit(1)
      )[0];
      if (!quotation) throw new NotFoundException(`quotation not found: ${id}`);
      if (!quotation.rfqId) {
        throw new ConflictException(
          `Quotation ${id} is not linked to an RFQ and cannot be selected as a winner.`,
        );
      }

      // Security review R1 #1: lock the RFQ row FIRST, before the existing-winner check below.
      // Without this, two concurrent selectQuotation calls for DIFFERENT quotations of the SAME
      // RFQ could both read "no winner yet" before either committed, and both go on to mark
      // themselves SELECTED — a double award (TOCTOU). With the lock, the second call blocks
      // here until the first transaction commits or rolls back, so its existing-winner check
      // below always sees the up-to-date, post-commit result. This also happens to prevent a
      // Postgres deadlock the two transactions could otherwise hit on the rfq_vendor_mappings
      // updates further down (each transaction touches both vendors' mapping rows in opposite
      // order once both existing-winner checks pass unlocked).
      await tx.select().from(rfqMaster).where(eq(rfqMaster.rfqId, quotation.rfqId)).for('update');

      const vendorMapping = quotation.vendorId
        ? (
            await tx
              .select()
              .from(rfqVendorMappings)
              .where(
                and(
                  eq(rfqVendorMappings.rfqId, quotation.rfqId),
                  eq(rfqVendorMappings.vendorId, quotation.vendorId),
                ),
              )
              .limit(1)
          )[0]
        : undefined;
      if (!vendorMapping) {
        throw new ForbiddenException(
          `Vendor ${quotation.vendorId ?? '(none)'} was never invited/mapped to RFQ ${quotation.rfqId} — a quotation from an unmapped vendor cannot be selected.`,
        );
      }

      // Double-award guard: some OTHER quotation for this RFQ already won.
      const existingWinner = (
        await tx
          .select({ quotationId: quotations.quotationId })
          .from(quotations)
          .where(
            and(
              eq(quotations.rfqId, quotation.rfqId),
              eq(quotations.status, 'SELECTED'),
              ne(quotations.quotationId, id),
            ),
          )
          .limit(1)
      )[0];
      if (existingWinner) {
        throw new ConflictException(
          `RFQ ${quotation.rfqId} already has an awarded quotation (${existingWinner.quotationId}); cannot award a second winner (double award).`,
        );
      }

      let updated;
      try {
        updated = ensure(
          (
            await tx
              .update(quotations)
              .set({ status: 'SELECTED', updatedBy: principal.userId })
              .where(eq(quotations.quotationId, id))
              .returning()
          )[0],
        );
      } catch (err) {
        // Belt-and-suspenders: the partial unique index quotations_rfq_selected_uq (rfq_id
        // WHERE status='SELECTED') turns a double award into a clean 409 even if the row lock
        // above were ever bypassed, instead of a raw constraint-violation 500.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException(
            `RFQ ${quotation.rfqId} already has an awarded quotation; cannot award a second winner (double award).`,
          );
        }
        throw err;
      }

      await tx
        .update(rfqVendorMappings)
        .set({ isSelectedVendor: false, updatedBy: principal.userId })
        .where(
          and(
            eq(rfqVendorMappings.rfqId, quotation.rfqId),
            ne(rfqVendorMappings.vendorId, quotation.vendorId ?? ''),
          ),
        );
      await tx
        .update(rfqVendorMappings)
        .set({ isSelectedVendor: true, updatedBy: principal.userId })
        .where(eq(rfqVendorMappings.rfqVendorMappingId, vendorMapping.rfqVendorMappingId));

      return updated;
    });
  }
}
