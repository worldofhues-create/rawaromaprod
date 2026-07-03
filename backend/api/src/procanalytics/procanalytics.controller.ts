/**
 * ProcAnalyticsController — vendor rate history + performance + negotiation (M03/M04). Reads are
 * gated to reveal-capable procurement roles (they surface material names + rates); negotiation
 * writes are re-checked in the service against the caller's token.
 */
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser, Permissions, type AuthPrincipal } from '@core/backend-kernel';
import { ProcAnalyticsService } from './procanalytics.service.js';

@Controller()
export class ProcAnalyticsController {
  constructor(private readonly svc: ProcAnalyticsService) {}

  @Permissions('inventory:grn_master:read')
  @Get('v1/qc-rejected-grns')
  qcRejectedGrns(@Query('limit') limit?: string) {
    return this.svc.qcRejectedGrns(limit ? Number(limit) : 200);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/vendor-ledger')
  vendorLedger(@Query('limit') limit?: string) {
    return this.svc.vendorLedger(limit ? Number(limit) : 200);
  }

  @Post('v1/replacement-po')
  createReplacementPo(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createReplacementPo(String(body.grnId), principal);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/vendor-dispatches')
  listVendorDispatches(@Query('limit') limit?: string) {
    return this.svc.listVendorDispatches(limit ? Number(limit) : 200);
  }

  @Post('v1/vendor-dispatches')
  createVendorDispatch(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createVendorDispatch(body, principal);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/po-advance-payments')
  listAdvancePayments(@Query('limit') limit?: string) {
    return this.svc.listAdvancePayments(limit ? Number(limit) : 200);
  }

  @Post('v1/po-advance-payments')
  createAdvancePayment(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createAdvancePayment(body, principal);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/vendor-rate-history')
  rateHistory(
    @Query('materialId') materialId?: string,
    @Query('vendorId') vendorId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.rateHistory(materialId, vendorId, limit ? Number(limit) : 200);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/vendor-performance')
  vendorPerformance(@Query('limit') limit?: string) {
    return this.svc.vendorPerformance(limit ? Number(limit) : 200);
  }

  @Permissions('procurement:quotation_items:read')
  @Get('v1/vendor-negotiations')
  listNegotiations(@Query('limit') limit?: string) {
    return this.svc.listNegotiations(limit ? Number(limit) : 200);
  }

  @Post('v1/vendor-negotiations')
  createNegotiation(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createNegotiation(body, principal);
  }
}
