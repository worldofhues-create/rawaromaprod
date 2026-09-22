/**
 * OrdersController — REST over the package-order document + its child rows. Reads require
 * `packaging:<table>:read`, writes `:write`. Flow endpoints: POST /package-orders creates the
 * order (+ BOM expansion + outbox); /filling-sessions/:id/end closes a session;
 * /filling-sessions/:id/details records a filling detail (+ optional signal). Per-arg
 * ZodValidationPipe; principal from the token.
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
  createFillingSession,
  createPackageOrder,
  createPackageOrderItem,
  endFillingSession,
  listQuery,
  recordFilling,
  type CreateFillingSession,
  type CreatePackageOrder,
  type CreatePackageOrderItem,
  type EndFillingSession,
  type ListQuery,
  type RecordFilling,
} from '../packaging.dtos.js';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /* ── package order (flow create + reads) ──────────────────────────── */

  @Permissions('packaging:package_order:read')
  @Get('v1/package-orders')
  listPackageOrders(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.orders.listPackageOrders(query);
  }

  @Permissions('packaging:package_order:read')
  @Get('v1/package-orders/:id')
  getPackageOrder(@Param('id') id: string) {
    return this.orders.getPackageOrder(id);
  }

  @Permissions('packaging:package_order:write')
  @Post('v1/package-orders')
  createPackageOrder(
    @Body(new ZodValidationPipe(createPackageOrder)) body: CreatePackageOrder,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.createPackageOrder(body, principal);
  }

  /* ── flow: guarded status transitions ─────────────────────────────── */

  @Permissions('packaging:package_order:write')
  @Post('v1/package-orders/:id/issue-materials')
  issuePackagingMaterials(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.orders.issuePackagingMaterials(id, principal);
  }

  @Permissions('packaging:package_order:write')
  @Post('v1/package-orders/:id/complete')
  completePackageOrder(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.orders.completePackageOrder(id, principal);
  }

  @Permissions('packaging:package_order:write')
  @Post('v1/package-orders/:id/cancel')
  cancelPackageOrder(@Param('id') id: string, @CurrentUser() principal: AuthPrincipal) {
    return this.orders.cancelPackageOrder(id, principal);
  }

  /* ── package order item ───────────────────────────────────────────── */

  @Permissions('packaging:package_order_item:read')
  @Get('v1/package-order-items')
  listPackageOrderItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.orders.listPackageOrderItems(query);
  }

  @Permissions('packaging:package_order_item:read')
  @Get('v1/package-order-items/:id')
  getPackageOrderItem(@Param('id') id: string) {
    return this.orders.getPackageOrderItem(id);
  }

  @Permissions('packaging:package_order_item:write')
  @Post('v1/package-order-items')
  createPackageOrderItem(
    @Body(new ZodValidationPipe(createPackageOrderItem)) body: CreatePackageOrderItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.createPackageOrderItem(body, principal);
  }

  /* ── filling session (flow start/end + reads) ─────────────────────── */

  @Permissions('packaging:filling_session:read')
  @Get('v1/filling-sessions')
  listFillingSessions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.orders.listFillingSessions(query);
  }

  @Permissions('packaging:filling_session:read')
  @Get('v1/filling-sessions/:id')
  getFillingSession(@Param('id') id: string) {
    return this.orders.getFillingSession(id);
  }

  @Permissions('packaging:filling_session:write')
  @Post('v1/filling-sessions')
  startFillingSession(
    @Body(new ZodValidationPipe(createFillingSession)) body: CreateFillingSession,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.startFillingSession(body, principal);
  }

  @Permissions('packaging:filling_session:write')
  @Post('v1/filling-sessions/:id/end')
  endFillingSession(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(endFillingSession)) body: EndFillingSession,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.endFillingSession(id, body, principal);
  }

  /* ── filling session details (flow record + reads) ────────────────── */

  @Permissions('packaging:filling_session_details:read')
  @Get('v1/filling-session-details')
  listFillingSessionDetails(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.orders.listFillingSessionDetails(query);
  }

  @Permissions('packaging:filling_session_details:read')
  @Get('v1/filling-session-details/:id')
  getFillingSessionDetail(@Param('id') id: string) {
    return this.orders.getFillingSessionDetail(id);
  }

  @Permissions('packaging:filling_session_details:write')
  @Post('v1/filling-sessions/:id/details')
  recordFilling(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(recordFilling)) body: RecordFilling,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.orders.recordFilling(id, body, principal);
  }
}
