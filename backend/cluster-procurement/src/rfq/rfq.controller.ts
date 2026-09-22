/**
 * RfqController — REST over the RFQ + quotation tables. Reads require
 * `procurement:<table>:read`, writes `:write`. Per-arg ZodValidationPipe; principal from the
 * token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { RfqService } from './rfq.service.js';
import {
  createQuotation,
  createQuotationItem,
  createRfqItem,
  createRfqMaster,
  createRfqVendorMapping,
  listQuery,
  selectQuotation,
  type CreateQuotation,
  type CreateQuotationItem,
  type CreateRfqItem,
  type CreateRfqMaster,
  type CreateRfqVendorMapping,
  type ListQuery,
  type SelectQuotation,
} from '../cluster-procurement.dtos.js';

@Controller()
export class RfqController {
  constructor(private readonly rfqs: RfqService) {}

  /* ── rfq_master ─────────────────────────────────────────────────────── */

  @Permissions('procurement:rfq_master:read')
  @Get('v1/rfqs')
  listRfqMasters(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.rfqs.listRfqMasters(query);
  }

  @Permissions('procurement:rfq_master:read')
  @Get('v1/rfqs/:id')
  getRfqMaster(@Param('id') id: string) {
    return this.rfqs.getRfqMaster(id);
  }

  @Permissions('procurement:rfq_master:write')
  @Post('v1/rfqs')
  createRfqMaster(
    @Body(new ZodValidationPipe(createRfqMaster)) body: CreateRfqMaster,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.rfqs.createRfqMaster(body, principal);
  }

  /* ── rfq_items ──────────────────────────────────────────────────────── */

  @Permissions('procurement:rfq_items:read')
  @Get('v1/rfq-items')
  listRfqItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.rfqs.listRfqItems(query);
  }

  @Permissions('procurement:rfq_items:read')
  @Get('v1/rfq-items/:id')
  getRfqItem(@Param('id') id: string) {
    return this.rfqs.getRfqItem(id);
  }

  @Permissions('procurement:rfq_items:write')
  @Post('v1/rfq-items')
  createRfqItem(
    @Body(new ZodValidationPipe(createRfqItem)) body: CreateRfqItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.rfqs.createRfqItem(body, principal);
  }

  /* ── rfq_vendor_mappings ────────────────────────────────────────────── */

  @Permissions('procurement:rfq_vendor_mappings:read')
  @Get('v1/rfq-vendor-mappings')
  listRfqVendorMappings(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.rfqs.listRfqVendorMappings(query);
  }

  @Permissions('procurement:rfq_vendor_mappings:read')
  @Get('v1/rfq-vendor-mappings/:id')
  getRfqVendorMapping(@Param('id') id: string) {
    return this.rfqs.getRfqVendorMapping(id);
  }

  @Permissions('procurement:rfq_vendor_mappings:write')
  @Post('v1/rfq-vendor-mappings')
  createRfqVendorMapping(
    @Body(new ZodValidationPipe(createRfqVendorMapping)) body: CreateRfqVendorMapping,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.rfqs.createRfqVendorMapping(body, principal);
  }

  /* ── quotations ─────────────────────────────────────────────────────── */

  @Permissions('procurement:quotations:read')
  @Get('v1/quotations')
  listQuotations(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.rfqs.listQuotations(query);
  }

  @Permissions('procurement:quotations:read')
  @Get('v1/quotations/:id')
  getQuotation(@Param('id') id: string) {
    return this.rfqs.getQuotation(id);
  }

  @Permissions('procurement:quotations:write')
  @Post('v1/quotations')
  createQuotation(
    @Body(new ZodValidationPipe(createQuotation)) body: CreateQuotation,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.rfqs.createQuotation(body, principal);
  }

  /* ── quotation_items ────────────────────────────────────────────────── */

  @Permissions('procurement:quotation_items:read')
  @Get('v1/quotation-items')
  listQuotationItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.rfqs.listQuotationItems(query);
  }

  @Permissions('procurement:quotation_items:read')
  @Get('v1/quotation-items/:id')
  getQuotationItem(@Param('id') id: string) {
    return this.rfqs.getQuotationItem(id);
  }

  @Permissions('procurement:quotation_items:write')
  @Post('v1/quotation-items')
  createQuotationItem(
    @Body(new ZodValidationPipe(createQuotationItem)) body: CreateQuotationItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.rfqs.createQuotationItem(body, principal);
  }

  /* ── select winning quotation (RFQ → PO gap, RP-PROC-006) ─────────────── */

  @Permissions('procurement:quotations:write')
  @Post('v1/quotations/:id/select')
  selectQuotation(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(selectQuotation)) body: SelectQuotation,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.rfqs.selectQuotation(id, body, principal);
  }
}
