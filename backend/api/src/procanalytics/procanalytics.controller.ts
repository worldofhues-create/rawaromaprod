/**
 * ProcAnalyticsController — vendor rate history + performance + negotiation (M03/M04). Reads are
 * gated to reveal-capable procurement roles (they surface material names + rates).
 *
 * Security review R1 follow-up (RP-PROC-007): every write route now ALSO carries an explicit
 * @Permissions decorator, matching the permission each service method already enforces
 * internally. Without it, PermissionsGuard's `if (!required) return true` let ANY authenticated
 * user reach the handler (any role, zero procurement permissions) and rely solely on the
 * in-service check — functionally still safe (the service check did reject them), but
 * inconsistent with how every other write route in this codebase is guarded, and one missed
 * in-service check away from a real hole. Guards here are defense-in-depth, not a behavior
 * change: the service-level checks are unchanged and still fire.
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

  @Permissions('procurement:purchase_order:write')
  @Post('v1/replacement-po')
  createReplacementPo(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createReplacementPo(String(body.grnId), principal);
  }

  @Permissions('iam:role_master:read')
  @Get('v1/approval-matrix')
  approvalMatrix(@Query('limit') limit?: string) {
    return this.svc.approvalMatrix(limit ? Number(limit) : 200);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/vendor-dispatches')
  listVendorDispatches(@Query('limit') limit?: string) {
    return this.svc.listVendorDispatches(limit ? Number(limit) : 200);
  }

  @Permissions('procurement:purchase_order:read')
  @Post('v1/vendor-dispatches')
  createVendorDispatch(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createVendorDispatch(body, principal);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/po-advance-payments')
  listAdvancePayments(@Query('limit') limit?: string) {
    return this.svc.listAdvancePayments(limit ? Number(limit) : 200);
  }

  @Permissions('procurement:purchase_order:write')
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

  @Permissions('procurement:quotation_items:write')
  @Post('v1/vendor-negotiations')
  createNegotiation(@Body() body: Record<string, unknown>, @CurrentUser() principal: AuthPrincipal) {
    return this.svc.createNegotiation(body, principal);
  }
}
