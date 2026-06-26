/**
 * InventoryController — REST over the inventory-ledger tables, including the
 * inventory-transaction write (POST /v1/inventory-transactions) which records an event-history
 * row. Reads require `inventory:<table>:read`, writes `:write`. Per-arg ZodValidationPipe;
 * principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { InventoryService } from './inventory.service.js';
import {
  createInventoryBatch,
  createInventoryEventHistory,
  createInventoryStatus,
  createInventoryTransaction,
  createInventoryTransactionType,
  listQuery,
  type CreateInventoryBatch,
  type CreateInventoryEventHistory,
  type CreateInventoryStatus,
  type CreateInventoryTransaction,
  type CreateInventoryTransactionType,
  type ListQuery,
} from '../cluster-inventory.dtos.js';

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /* ── inventory_status_master ────────────────────────────────────────── */

  @Permissions('inventory:inventory_status_master:read')
  @Get('v1/inventory-statuses')
  listInventoryStatuses(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inventory.listInventoryStatuses(query);
  }

  @Permissions('inventory:inventory_status_master:read')
  @Get('v1/inventory-statuses/:id')
  getInventoryStatus(@Param('id') id: string) {
    return this.inventory.getInventoryStatus(id);
  }

  @Permissions('inventory:inventory_status_master:write')
  @Post('v1/inventory-statuses')
  createInventoryStatus(
    @Body(new ZodValidationPipe(createInventoryStatus)) body: CreateInventoryStatus,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inventory.createInventoryStatus(body, principal);
  }

  /* ── inventory_batch ────────────────────────────────────────────────── */

  @Permissions('inventory:inventory_batch:read')
  @Get('v1/inventory-batches')
  listInventoryBatches(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inventory.listInventoryBatches(query);
  }

  @Permissions('inventory:inventory_batch:read')
  @Get('v1/inventory-batches/:id')
  getInventoryBatch(@Param('id') id: string) {
    return this.inventory.getInventoryBatch(id);
  }

  @Permissions('inventory:inventory_batch:write')
  @Post('v1/inventory-batches')
  createInventoryBatch(
    @Body(new ZodValidationPipe(createInventoryBatch)) body: CreateInventoryBatch,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inventory.createInventoryBatch(body, principal);
  }

  /* ── inventory_transaction_type_master ──────────────────────────────── */

  @Permissions('inventory:inventory_transaction_type_master:read')
  @Get('v1/inventory-transaction-types')
  listInventoryTransactionTypes(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inventory.listInventoryTransactionTypes(query);
  }

  @Permissions('inventory:inventory_transaction_type_master:read')
  @Get('v1/inventory-transaction-types/:id')
  getInventoryTransactionType(@Param('id') id: string) {
    return this.inventory.getInventoryTransactionType(id);
  }

  @Permissions('inventory:inventory_transaction_type_master:write')
  @Post('v1/inventory-transaction-types')
  createInventoryTransactionType(
    @Body(new ZodValidationPipe(createInventoryTransactionType))
    body: CreateInventoryTransactionType,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inventory.createInventoryTransactionType(body, principal);
  }

  /* ── inventory_transaction ──────────────────────────────────────────── */

  @Permissions('inventory:inventory_transaction:read')
  @Get('v1/inventory-transactions')
  listInventoryTransactions(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inventory.listInventoryTransactions(query);
  }

  @Permissions('inventory:inventory_transaction:read')
  @Get('v1/inventory-transactions/:id')
  getInventoryTransaction(@Param('id') id: string) {
    return this.inventory.getInventoryTransaction(id);
  }

  @Permissions('inventory:inventory_transaction:write')
  @Post('v1/inventory-transactions')
  createInventoryTransaction(
    @Body(new ZodValidationPipe(createInventoryTransaction))
    body: CreateInventoryTransaction,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inventory.createInventoryTransaction(body, principal);
  }

  /* ── inventory_event_history ────────────────────────────────────────── */

  @Permissions('inventory:inventory_event_history:read')
  @Get('v1/inventory-event-histories')
  listInventoryEventHistories(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.inventory.listInventoryEventHistories(query);
  }

  @Permissions('inventory:inventory_event_history:read')
  @Get('v1/inventory-event-histories/:id')
  getInventoryEventHistory(@Param('id') id: string) {
    return this.inventory.getInventoryEventHistory(id);
  }

  @Permissions('inventory:inventory_event_history:write')
  @Post('v1/inventory-event-histories')
  createInventoryEventHistory(
    @Body(new ZodValidationPipe(createInventoryEventHistory))
    body: CreateInventoryEventHistory,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.inventory.createInventoryEventHistory(body, principal);
  }
}
