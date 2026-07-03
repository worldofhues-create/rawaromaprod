/**
 * VendorService — CRUD over the vendor masters: VENDOR_DETAILS, VENDOR_CONTACT,
 * VENDOR_RM_MAPPING. Create stamps status "ACTIVE" + created_by/updated_by from the
 * principal. List is cursor-paginated by descending PK. Soft refs (organization_id,
 * address_id, base_currency_id, material_id) are inserted as plain uuids.
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
  CreateVendorContact,
  CreateVendorDetails,
  CreateVendorRmMapping,
} from '../cluster-procurement.dtos.js';
import { ensure, paginate } from '../_helpers.js';

const { vendorDetails, vendorContact, vendorRmMapping } = procurementSchema;

@Injectable()
export class VendorService {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  /* ── vendor_details ─────────────────────────────────────────────────── */

  async createVendorDetails(body: CreateVendorDetails, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(vendorDetails)
          .values({
            organizationId: body.organizationId ?? null,
            vendorCode: body.vendorCode ?? null,
            vendorName: body.vendorName ?? null,
            addressId: body.addressId ?? null,
            baseCurrencyId: body.baseCurrencyId ?? null,
            paymentTerms: body.paymentTerms ?? null,
            gstin: body.gstin ?? null,
            panNumber: body.panNumber ?? null,
            bankName: body.bankName ?? null,
            bankAccountNumber: body.bankAccountNumber ?? null,
            bankIfsc: body.bankIfsc ?? null,
            contactEmail: body.contactEmail ?? null,
            contactPhone: body.contactPhone ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listVendorDetails(
    query: ListQuery,
  ): Promise<Page<typeof vendorDetails.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(vendorDetails)
      .where(query.cursor ? lt(vendorDetails.vendorId, query.cursor) : undefined)
      .orderBy(desc(vendorDetails.vendorId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vendorId);
  }

  async getVendorDetails(id: string) {
    return (
      (
        await this.db
          .select()
          .from(vendorDetails)
          .where(eq(vendorDetails.vendorId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── vendor_contact ─────────────────────────────────────────────────── */

  async createVendorContact(body: CreateVendorContact, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(vendorContact)
          .values({
            vendorId: body.vendorId ?? null,
            contactName: body.contactName ?? null,
            designation: body.designation ?? null,
            email: body.email ?? null,
            mobileNumber: body.mobileNumber ?? null,
            isPrimary: body.isPrimary ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listVendorContacts(
    query: ListQuery,
  ): Promise<Page<typeof vendorContact.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(vendorContact)
      .where(query.cursor ? lt(vendorContact.vendorContactId, query.cursor) : undefined)
      .orderBy(desc(vendorContact.vendorContactId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vendorContactId);
  }

  async getVendorContact(id: string) {
    return (
      (
        await this.db
          .select()
          .from(vendorContact)
          .where(eq(vendorContact.vendorContactId, id))
          .limit(1)
      )[0] ?? null
    );
  }

  /* ── vendor_rm_mapping ──────────────────────────────────────────────── */

  async createVendorRmMapping(body: CreateVendorRmMapping, principal: AuthPrincipal) {
    return ensure(
      (
        await this.db
          .insert(vendorRmMapping)
          .values({
            vendorId: body.vendorId ?? null,
            materialId: body.materialId ?? null,
            isPreferred: body.isPreferred ?? null,
            leadTimeDays: body.leadTimeDays ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0],
    );
  }

  async listVendorRmMappings(
    query: ListQuery,
  ): Promise<Page<typeof vendorRmMapping.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(vendorRmMapping)
      .where(
        query.cursor ? lt(vendorRmMapping.vendorRmMappingId, query.cursor) : undefined,
      )
      .orderBy(desc(vendorRmMapping.vendorRmMappingId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.vendorRmMappingId);
  }

  async getVendorRmMapping(id: string) {
    return (
      (
        await this.db
          .select()
          .from(vendorRmMapping)
          .where(eq(vendorRmMapping.vendorRmMappingId, id))
          .limit(1)
      )[0] ?? null
    );
  }
}
