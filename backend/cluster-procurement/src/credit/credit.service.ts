/**
 * CreditService — CRUD over the vendor-credit tables (VENDOR_CREDIT_REASON_MASTER,
 * VENDOR_CREDIT_NOTE, VENDOR_CREDIT_NOTES_ALLOCATION). Create stamps status "ACTIVE" +
 * created_by/updated_by. numeric → String(n); dates stay ISO date strings. grn_id,
 * purchase_order_id and currency_id are soft refs inserted as plain uuids.
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
  CreateVendorCreditNote,
  CreateVendorCreditNotesAllocation,
  CreateVendorCreditReason,
} from '../cluster-procurement.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const { vendorCreditReasonMaster, vendorCreditNote, vendorCreditNotesAllocation } =
  procurementSchema;

@Injectable()
export class CreditService {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  /* ── vendor_credit_reason_master ────────────────────────────────────── */

  async createVendorCreditReason(
    body: CreateVendorCreditReason,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(vendorCreditReasonMaster)
          .values({
            reasonCode: body.reasonCode ?? null,
            reasonDescription: body.reasonDescription ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listVendorCreditReasons(
    query: ListQuery,
  ): Promise<Page<typeof vendorCreditReasonMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(vendorCreditReasonMaster)
      .where(
        query.cursor
          ? lt(vendorCreditReasonMaster.vendorCreditReasonId, query.cursor)
          : undefined,
      )
      .orderBy(desc(vendorCreditReasonMaster.vendorCreditReasonId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vendorCreditReasonId);
  }

  async getVendorCreditReason(id: string) {
    return (
      (
        await this.db
          .select()
          .from(vendorCreditReasonMaster)
          .where(eq(vendorCreditReasonMaster.vendorCreditReasonId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── vendor_credit_note ─────────────────────────────────────────────── */

  async createVendorCreditNote(body: CreateVendorCreditNote, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(vendorCreditNote)
          .values({
            vendorId: body.vendorId ?? null,
            grnId: body.grnId ?? null,
            vendorCreditReasonId: body.vendorCreditReasonId ?? null,
            creditNoteNumber: body.creditNoteNumber ?? null,
            creditNoteDate: body.creditNoteDate ?? null,
            amount: body.amount != null ? String(body.amount) : null,
            currencyId: body.currencyId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listVendorCreditNotes(
    query: ListQuery,
  ): Promise<Page<typeof vendorCreditNote.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(vendorCreditNote)
      .where(
        query.cursor ? lt(vendorCreditNote.vendorCreditNoteId, query.cursor) : undefined,
      )
      .orderBy(desc(vendorCreditNote.vendorCreditNoteId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vendorCreditNoteId);
  }

  async getVendorCreditNote(id: string) {
    return (
      (
        await this.db
          .select()
          .from(vendorCreditNote)
          .where(eq(vendorCreditNote.vendorCreditNoteId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── vendor_credit_notes_allocation ─────────────────────────────────── */

  async createVendorCreditNotesAllocation(
    body: CreateVendorCreditNotesAllocation,
    principal: AuthPrincipal,
  ) {
    return ensure(
      (
        await this.db
          .insert(vendorCreditNotesAllocation)
          .values({
            vendorCreditNoteId: body.vendorCreditNoteId ?? null,
            purchaseOrderId: body.purchaseOrderId ?? null,
            allocatedAmount:
              body.allocatedAmount != null ? String(body.allocatedAmount) : null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listVendorCreditNotesAllocations(
    query: ListQuery,
  ): Promise<Page<typeof vendorCreditNotesAllocation.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(vendorCreditNotesAllocation)
      .where(
        query.cursor
          ? lt(
              vendorCreditNotesAllocation.vendorCreditNotesAllocationId,
              query.cursor,
            )
          : undefined,
      )
      .orderBy(desc(vendorCreditNotesAllocation.vendorCreditNotesAllocationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vendorCreditNotesAllocationId);
  }

  async getVendorCreditNotesAllocation(id: string) {
    return (
      (
        await this.db
          .select()
          .from(vendorCreditNotesAllocation)
          .where(eq(vendorCreditNotesAllocation.vendorCreditNotesAllocationId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
