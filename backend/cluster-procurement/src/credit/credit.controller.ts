/**
 * CreditController — REST over the vendor-credit tables. Reads require
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
import { CreditService } from './credit.service.js';
import {
  createVendorCreditNote,
  createVendorCreditNotesAllocation,
  createVendorCreditReason,
  listQuery,
  type CreateVendorCreditNote,
  type CreateVendorCreditNotesAllocation,
  type CreateVendorCreditReason,
  type ListQuery,
} from '../cluster-procurement.dtos.js';

@Controller()
export class CreditController {
  constructor(private readonly credits: CreditService) {}

  /* ── vendor_credit_reason_master ────────────────────────────────────── */

  @Permissions('procurement:vendor_credit_reason_master:read')
  @Get('v1/vendor-credit-reasons')
  listVendorCreditReasons(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.credits.listVendorCreditReasons(query);
  }

  @Permissions('procurement:vendor_credit_reason_master:read')
  @Get('v1/vendor-credit-reasons/:id')
  getVendorCreditReason(@Param('id') id: string) {
    return this.credits.getVendorCreditReason(id);
  }

  @Permissions('procurement:vendor_credit_reason_master:write')
  @Post('v1/vendor-credit-reasons')
  createVendorCreditReason(
    @Body(new ZodValidationPipe(createVendorCreditReason)) body: CreateVendorCreditReason,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.credits.createVendorCreditReason(body, principal);
  }

  /* ── vendor_credit_note ─────────────────────────────────────────────── */

  @Permissions('procurement:vendor_credit_note:read')
  @Get('v1/vendor-credit-notes')
  listVendorCreditNotes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.credits.listVendorCreditNotes(query);
  }

  @Permissions('procurement:vendor_credit_note:read')
  @Get('v1/vendor-credit-notes/:id')
  getVendorCreditNote(@Param('id') id: string) {
    return this.credits.getVendorCreditNote(id);
  }

  @Permissions('procurement:vendor_credit_note:write')
  @Post('v1/vendor-credit-notes')
  createVendorCreditNote(
    @Body(new ZodValidationPipe(createVendorCreditNote)) body: CreateVendorCreditNote,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.credits.createVendorCreditNote(body, principal);
  }

  /* ── vendor_credit_notes_allocation ─────────────────────────────────── */

  @Permissions('procurement:vendor_credit_notes_allocation:read')
  @Get('v1/vendor-credit-allocations')
  listVendorCreditNotesAllocations(
    @Query(new ZodValidationPipe(listQuery)) query: ListQuery,
  ) {
    return this.credits.listVendorCreditNotesAllocations(query);
  }

  @Permissions('procurement:vendor_credit_notes_allocation:read')
  @Get('v1/vendor-credit-allocations/:id')
  getVendorCreditNotesAllocation(@Param('id') id: string) {
    return this.credits.getVendorCreditNotesAllocation(id);
  }

  @Permissions('procurement:vendor_credit_notes_allocation:write')
  @Post('v1/vendor-credit-allocations')
  createVendorCreditNotesAllocation(
    @Body(new ZodValidationPipe(createVendorCreditNotesAllocation))
    body: CreateVendorCreditNotesAllocation,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.credits.createVendorCreditNotesAllocation(body, principal);
  }
}
