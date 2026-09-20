/**
 * StockController — REST over the stock-operation tables + expiry tracker, including the
 * stock-audit create flow (POST /v1/stock-audits writes the header + detail lines). Reads
 * require `inventory:<table>:read`, writes `:write`. Per-arg ZodValidationPipe; principal
 * from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { StockService } from './stock.service.js';
import {
  createExpiryTracker,
  createStockAdjustment,
  createStockAudit,
  createStockAuditDetail,
  createStockReservation,
  createStockTransfer,
  listQuery,
  type CreateExpiryTracker,
  type CreateStockAdjustment,
  type CreateStockAudit,
  type CreateStockAuditDetail,
  type CreateStockReservation,
  type CreateStockTransfer,
  type ListQuery,
} from '../cluster-inventory.dtos.js';

@Controller()
export class StockController {
  constructor(private readonly stock: StockService) {}

  /* ── stock_adjustment ───────────────────────────────────────────────── */

  @Permissions('inventory:stock_adjustment:read')
  @Get('v1/stock-adjustments')
  listStockAdjustments(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.stock.listStockAdjustments(query);
  }

  @Permissions('inventory:stock_adjustment:read')
  @Get('v1/stock-adjustments/:id')
  getStockAdjustment(@Param('id') id: string) {
    return this.stock.getStockAdjustment(id);
  }

  @Permissions('inventory:stock_adjustment:write')
  @Post('v1/stock-adjustments')
  createStockAdjustment(
    @Body(new ZodValidationPipe(createStockAdjustment)) body: CreateStockAdjustment,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.stock.createStockAdjustment(body, principal);
  }

  /* ── stock_audit ────────────────────────────────────────────────────── */

  @Permissions('inventory:stock_audit:read')
  @Get('v1/stock-audits')
  listStockAudits(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.stock.listStockAudits(query);
  }

  @Permissions('inventory:stock_audit:read')
  @Get('v1/stock-audits/:id')
  getStockAudit(@Param('id') id: string) {
    return this.stock.getStockAudit(id);
  }

  @Permissions('inventory:stock_audit:write')
  @Post('v1/stock-audits')
  createStockAudit(
    @Body(new ZodValidationPipe(createStockAudit)) body: CreateStockAudit,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.stock.createStockAudit(body, principal);
  }

  /* ── stock_audit_details ────────────────────────────────────────────── */

  @Permissions('inventory:stock_audit_details:read')
  @Get('v1/stock-audit-details')
  listStockAuditDetails(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.stock.listStockAuditDetails(query);
  }

  @Permissions('inventory:stock_audit_details:read')
  @Get('v1/stock-audit-details/:id')
  getStockAuditDetail(@Param('id') id: string) {
    return this.stock.getStockAuditDetail(id);
  }

  @Permissions('inventory:stock_audit_details:write')
  @Post('v1/stock-audit-details')
  createStockAuditDetail(
    @Body(new ZodValidationPipe(createStockAuditDetail)) body: CreateStockAuditDetail,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.stock.createStockAuditDetail(body, principal);
  }

  /* ── stock_reservation ──────────────────────────────────────────────── */

  @Permissions('inventory:stock_reservation:read')
  @Get('v1/stock-reservations')
  listStockReservations(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.stock.listStockReservations(query);
  }

  @Permissions('inventory:stock_reservation:read')
  @Get('v1/stock-reservations/:id')
  getStockReservation(@Param('id') id: string) {
    return this.stock.getStockReservation(id);
  }

  @Permissions('inventory:stock_reservation:write')
  @Post('v1/stock-reservations')
  createStockReservation(
    @Body(new ZodValidationPipe(createStockReservation)) body: CreateStockReservation,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.stock.createStockReservation(body, principal);
  }

  /* ── stock_transfer ─────────────────────────────────────────────────── */

  @Permissions('inventory:stock_transfer:read')
  @Get('v1/stock-transfers')
  listStockTransfers(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.stock.listStockTransfers(query);
  }

  @Permissions('inventory:stock_transfer:read')
  @Get('v1/stock-transfers/:id')
  getStockTransfer(@Param('id') id: string) {
    return this.stock.getStockTransfer(id);
  }

  @Permissions('inventory:stock_transfer:write')
  @Post('v1/stock-transfers')
  createStockTransfer(
    @Body(new ZodValidationPipe(createStockTransfer)) body: CreateStockTransfer,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.stock.createStockTransfer(body, principal);
  }

  /* ── expiry_tracker ─────────────────────────────────────────────────── */

  @Permissions('inventory:expiry_tracker:read')
  @Get('v1/expiry-trackers')
  listExpiryTrackers(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.stock.listExpiryTrackers(query);
  }

  @Permissions('inventory:expiry_tracker:read')
  @Get('v1/expiry-trackers/:id')
  getExpiryTracker(@Param('id') id: string) {
    return this.stock.getExpiryTracker(id);
  }

  @Permissions('inventory:expiry_tracker:write')
  @Post('v1/expiry-trackers')
  createExpiryTracker(
    @Body(new ZodValidationPipe(createExpiryTracker)) body: CreateExpiryTracker,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.stock.createExpiryTracker(body, principal);
  }
}
