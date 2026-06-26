/**
 * OrdersController — REST over the sales order document + its child lines. Reads require
 * `sales:<table>:read`, writes `:write`. The flow endpoints: POST /sales-orders creates the
 * header + lines and fires `sales.order.created`; POST /sales-orders/:id/confirm flips status
 * and fires `sales.order.confirmed`. Per-arg ZodValidationPipe; principal from the token.
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
  type CreateSalesOrder,
  type CreateSalesOrderItem,
  type ListQuery,
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

  /* ── flow: create with items ──────────────────────────────────────── */

  @Permissions('sales:sales_order:write')
  @Post('v1/sales-orders')
  createSalesOrder(
    @Body(new ZodValidationPipe(createSalesOrder)) body: CreateSalesOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.createSalesOrder(body, principal);
  }

  /* ── flow: confirm ────────────────────────────────────────────────── */

  @Permissions('sales:sales_order:write')
  @Post('v1/sales-orders/:id/confirm')
  confirmSalesOrder(
    @Param('id') id: string,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.confirmSalesOrder(id, principal);
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

  @Permissions('sales:sales_order_items:write')
  @Post('v1/sales-order-items')
  createSalesOrderItem(
    @Body(new ZodValidationPipe(createSalesOrderItem)) body: CreateSalesOrderItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.createSalesOrderItem(body, principal);
  }
}
