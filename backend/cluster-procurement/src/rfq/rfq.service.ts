/**
 * RfqService — CRUD over the RFQ + quotation tables (RFQ_MASTER, RFQ_ITEMS,
 * RFQ_VENDOR_MAPPINGS, QUOTATIONS, QUOTATION_ITEMS). quotations + quotation_items record a
 * vendor's response to an RFQ. Create stamps status "ACTIVE" + created_by/updated_by.
 * numeric → String(n); dates stay ISO date strings (date columns). Soft refs are plain uuids.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
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

  async listRfqMasters(query: ListQuery): Promise<Page<typeof rfqMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(rfqMaster)
      .where(query.cursor ? lt(rfqMaster.rfqId, query.cursor) : undefined)
      .orderBy(desc(rfqMaster.rfqId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rfqId);
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

  async listQuotationItems(
    query: ListQuery,
  ): Promise<Page<typeof quotationItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(quotationItems)
      .where(query.cursor ? lt(quotationItems.quotationItemId, query.cursor) : undefined)
      .orderBy(desc(quotationItems.quotationItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.quotationItemId);
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
}
