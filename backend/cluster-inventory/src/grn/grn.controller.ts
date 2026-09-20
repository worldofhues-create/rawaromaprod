/**
 * GrnController — REST over the GRN tables, plus the GRN receiving flow (POST /v1/grns).
 * Reads require `inventory:<table>:read`, writes `:write`. Per-arg ZodValidationPipe;
 * principal from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { GrnService } from './grn.service.js';
import {
  createGrn,
  createGrnContainer,
  createGrnItem,
  listQuery,
  type CreateGrn,
  type CreateGrnContainer,
  type CreateGrnItem,
  type ListQuery,
} from '../cluster-inventory.dtos.js';

@Controller()
export class GrnController {
  constructor(private readonly grns: GrnService) {}

  /* ── grn_master ─────────────────────────────────────────────────────── */

  @Permissions('inventory:grn_master:read')
  @Get('v1/grns')
  listGrns(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.grns.listGrns(query);
  }

  @Permissions('inventory:grn_master:read')
  @Get('v1/grns/:id')
  getGrn(@Param('id') id: string) {
    return this.grns.getGrn(id);
  }

  @Permissions('inventory:grn_master:write')
  @Post('v1/grns')
  createGrn(
    @Body(new ZodValidationPipe(createGrn)) body: CreateGrn,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.grns.createGrn(body, principal);
  }

  /* ── grn_items ──────────────────────────────────────────────────────── */

  @Permissions('inventory:grn_items:read')
  @Get('v1/grn-items')
  listGrnItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.grns.listGrnItems(query);
  }

  @Permissions('inventory:grn_items:read')
  @Get('v1/grn-items/:id')
  getGrnItem(@Param('id') id: string) {
    return this.grns.getGrnItem(id);
  }

  @Permissions('inventory:grn_items:write')
  @Post('v1/grn-items')
  createGrnItem(
    @Body(new ZodValidationPipe(createGrnItem)) body: CreateGrnItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.grns.createGrnItem(body, principal);
  }

  /* ── grn_container ──────────────────────────────────────────────────── */

  @Permissions('inventory:grn_container:read')
  @Get('v1/grn-containers')
  listGrnContainers(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.grns.listGrnContainers(query);
  }

  @Permissions('inventory:grn_container:read')
  @Get('v1/grn-containers/:id')
  getGrnContainer(@Param('id') id: string) {
    return this.grns.getGrnContainer(id);
  }

  @Permissions('inventory:grn_container:write')
  @Post('v1/grn-containers')
  createGrnContainer(
    @Body(new ZodValidationPipe(createGrnContainer)) body: CreateGrnContainer,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.grns.createGrnContainer(body, principal);
  }
}
