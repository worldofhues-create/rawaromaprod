/**
 * OrdersController — REST over the sales order document + its child lines. Reads require
 * `sales:<table>:read`. G1/PB-08 (FINAL_OS §2.3/§41): RawProd must not be an independent
 * commercial-order writer — a sales order should originate from the ALEMBIC bridge, not a
 * direct manual POST. Until that importer path exists, create/confirm/item-add are a
 * break-glass CONTINUITY path, gated on `sales:manual_continuity:write` instead of the ordinary
 * `sales:sales_order(_items):write` (owner/admin only — see scripts/ra-roles.ts
 * MANUAL_CONTINUITY_ROLES; no factory/sales role holds it). Every call requires a `reason`,
 * which OrdersService audits (stamped on the row) and reports to ALEMBIC via the bridge
 * outbox so it can reconcile. Per-arg ZodValidationPipe; principal from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { OrdersService } from './orders.service.js';
import {
  createSalesOrder,
  createSalesOrderItem,
  listQuery,
  manualContinuityReason,
  type CreateSalesOrder,
  type CreateSalesOrderItem,
  type ListQuery,
  type ManualContinuityReason,
} from '../sales.dtos.js';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /* ── sales order ──────────────────────────────────────────────────── */

  @Permissions('sales:sales_order:read')
  @Get('v1/sales-orders')
  listSalesOrders(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.orders.listSalesOrders(query);
  }

  @Permissions('sales:sales_order:read')
  @Get('v1/sales-orders/:id')
  getSalesOrder(@Param('id') id: string) {
    return this.orders.getSalesOrder(id);
  }

  /* ── flow: create with items (break-glass manual continuity) ───────── */

  @Permissions('sales:manual_continuity:write')
  @Post('v1/sales-orders')
  createSalesOrder(
    @Body(new ZodValidationPipe(createSalesOrder)) body: CreateSalesOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.createSalesOrder(body, principal);
  }

  /* ── flow: confirm (break-glass manual continuity) ──────────────────── */

  @Permissions('sales:manual_continuity:write')
  @Post('v1/sales-orders/:id/confirm')
  confirmSalesOrder(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(manualContinuityReason)) body: ManualContinuityReason,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.confirmSalesOrder(id, body, principal);
  }

  /* ── sales order items ────────────────────────────────────────────── */

  @Permissions('sales:sales_order_items:read')
  @Get('v1/sales-order-items')
  listSalesOrderItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.orders.listSalesOrderItems(query);
  }

  @Permissions('sales:sales_order_items:read')
  @Get('v1/sales-order-items/:id')
  getSalesOrderItem(@Param('id') id: string) {
    return this.orders.getSalesOrderItem(id);
  }

  // Break-glass manual continuity (see class doc) — item-add on an existing sales order is one
  // of the three manual write paths G1/PB-08 locks down, same as create/confirm above.
  @Permissions('sales:manual_continuity:write')
  @Post('v1/sales-order-items')
  createSalesOrderItem(
    @Body(new ZodValidationPipe(createSalesOrderItem)) body: CreateSalesOrderItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.createSalesOrderItem(body, principal);
  }
}
