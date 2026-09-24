/**
 * PoController — REST over the PO tables, plus the PO flow endpoints
 * (approve/issue/acknowledge). Reads require `procurement:<table>:read`, writes and flow
 * transitions `:write`. Per-arg ZodValidationPipe; principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { PoService } from './po.service.js';
import {
  acknowledgePurchaseOrder,
  amendPurchaseOrder,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPoApprovalOrder,
  createPurchaseOrder,
  createPurchaseOrderItem,
  createVendorPoAck,
  listQuery,
  type AcknowledgePurchaseOrder,
  type AmendPurchaseOrder,
  type ApprovePurchaseOrder,
  type CancelPurchaseOrder,
  type CreatePoApprovalOrder,
  type CreatePurchaseOrder,
  type CreatePurchaseOrderItem,
  type CreateVendorPoAck,
  type ListQuery,
} from '../cluster-procurement.dtos.js';

@Controller()
export class PoController {
  constructor(private readonly pos: PoService) {}

  /* ── purchase_order ─────────────────────────────────────────────────── */

  @Permissions('procurement:purchase_order:read')
  @Get('v1/purchase-orders')
  listPurchaseOrders(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.pos.listPurchaseOrders(query);
  }

  @Permissions('procurement:purchase_order:read')
  @Get('v1/purchase-orders/:id')
  getPurchaseOrder(@Param('id') id: string) {
    return this.pos.getPurchaseOrder(id);
  }

  @Permissions('procurement:purchase_order:write')
  @Post('v1/purchase-orders')
  createPurchaseOrder(
    @Body(new ZodValidationPipe(createPurchaseOrder)) body: CreatePurchaseOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.createPurchaseOrder(body, principal);
  }

  @Permissions('procurement:purchase_order:write')
  @Post('v1/purchase-orders/:id/approve')
  approvePurchaseOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approvePurchaseOrder)) body: ApprovePurchaseOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.approvePurchaseOrder(id, body, principal);
  }

  @Permissions('procurement:purchase_order:write')
  @Post('v1/purchase-orders/:id/issue')
  issuePurchaseOrder(
    @Param('id') id: string,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.issuePurchaseOrder(id, principal);
  }

  @Permissions('procurement:purchase_order:write')
  @Post('v1/purchase-orders/:id/acknowledge')
  acknowledgePurchaseOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(acknowledgePurchaseOrder)) body: AcknowledgePurchaseOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.acknowledgePurchaseOrder(id, body, principal);
  }

  // G2/V4 §113 — new revision linked to the original; re-approval per existing thresholds.
  @Permissions('procurement:purchase_order:write')
  @Post('v1/purchase-orders/:id/amend')
  amendPurchaseOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(amendPurchaseOrder)) body: AmendPurchaseOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.amendPurchaseOrder(id, body, principal);
  }

  // G2/V4 §113 — reason required, audited, refused once a GRN exists; emits a vendor
  // notification event.
  @Permissions('procurement:purchase_order:write')
  @Post('v1/purchase-orders/:id/cancel')
  cancelPurchaseOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelPurchaseOrder)) body: CancelPurchaseOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.cancelPurchaseOrder(id, body, principal);
  }

  /* ── purchase_order_items ───────────────────────────────────────────── */

  @Permissions('procurement:purchase_order_items:read')
  @Get('v1/purchase-order-items')
  listPurchaseOrderItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.pos.listPurchaseOrderItems(query);
  }

  @Permissions('procurement:purchase_order_items:read')
  @Get('v1/purchase-order-items/:id')
  getPurchaseOrderItem(@Param('id') id: string) {
    return this.pos.getPurchaseOrderItem(id);
  }

  @Permissions('procurement:purchase_order_items:write')
  @Post('v1/purchase-order-items')
  createPurchaseOrderItem(
    @Body(new ZodValidationPipe(createPurchaseOrderItem)) body: CreatePurchaseOrderItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.createPurchaseOrderItem(body, principal);
  }

  /* ── po_approval_order ──────────────────────────────────────────────── */

  @Permissions('procurement:po_approval_order:read')
  @Get('v1/po-approval-orders')
  listPoApprovalOrders(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.pos.listPoApprovalOrders(query);
  }

  @Permissions('procurement:po_approval_order:read')
  @Get('v1/po-approval-orders/:id')
  getPoApprovalOrder(@Param('id') id: string) {
    return this.pos.getPoApprovalOrder(id);
  }

  @Permissions('procurement:po_approval_order:write')
  @Post('v1/po-approval-orders')
  createPoApprovalOrder(
    @Body(new ZodValidationPipe(createPoApprovalOrder)) body: CreatePoApprovalOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.createPoApprovalOrder(body, principal);
  }

  /* ── vendor_po_ack ──────────────────────────────────────────────────── */

  @Permissions('procurement:vendor_po_ack:read')
  @Get('v1/vendor-po-acks')
  listVendorPoAcks(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.pos.listVendorPoAcks(query);
  }

  @Permissions('procurement:vendor_po_ack:read')
  @Get('v1/vendor-po-acks/:id')
  getVendorPoAck(@Param('id') id: string) {
    return this.pos.getVendorPoAck(id);
  }

  @Permissions('procurement:vendor_po_ack:write')
  @Post('v1/vendor-po-acks')
  createVendorPoAck(
    @Body(new ZodValidationPipe(createVendorPoAck)) body: CreateVendorPoAck,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.pos.createVendorPoAck(body, principal);
  }
}
