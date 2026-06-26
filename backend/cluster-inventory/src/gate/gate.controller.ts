/**
 * GateController — REST over the gate-entry tables. Reads require `inventory:<table>:read`,
 * writes `:write`. Per-arg ZodValidationPipe; principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { GateService } from './gate.service.js';
import {
  createGateEntry,
  createGateEntryDocument,
  listQuery,
  type CreateGateEntry,
  type CreateGateEntryDocument,
  type ListQuery,
} from '../cluster-inventory.dtos.js';

@Controller()
export class GateController {
  constructor(private readonly gate: GateService) {}

  /* ── gate_entry_master ──────────────────────────────────────────────── */

  @Permissions('inventory:gate_entry_master:read')
  @Get('v1/gate-entries')
  listGateEntries(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.gate.listGateEntries(query);
  }

  @Permissions('inventory:gate_entry_master:read')
  @Get('v1/gate-entries/:id')
  getGateEntry(@Param('id') id: string) {
    return this.gate.getGateEntry(id);
  }

  @Permissions('inventory:gate_entry_master:write')
  @Post('v1/gate-entries')
  createGateEntry(
    @Body(new ZodValidationPipe(createGateEntry)) body: CreateGateEntry,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.gate.createGateEntry(body, principal);
  }

  /* ── gate_entry_documents ───────────────────────────────────────────── */

  @Permissions('inventory:gate_entry_documents:read')
  @Get('v1/gate-entry-documents')
  listGateEntryDocuments(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.gate.listGateEntryDocuments(query);
  }

  @Permissions('inventory:gate_entry_documents:read')
  @Get('v1/gate-entry-documents/:id')
  getGateEntryDocument(@Param('id') id: string) {
    return this.gate.getGateEntryDocument(id);
  }

  @Permissions('inventory:gate_entry_documents:write')
  @Post('v1/gate-entry-documents')
  createGateEntryDocument(
    @Body(new ZodValidationPipe(createGateEntryDocument)) body: CreateGateEntryDocument,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.gate.createGateEntryDocument(body, principal);
  }
}
