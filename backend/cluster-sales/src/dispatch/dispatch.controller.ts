/**
 * DispatchController — REST over the dispatch document + its child lines. Reads require
 * `sales:<table>:read`, writes `:write`. The flow endpoint: POST /dispatches creates the
 * header + lines and fires `sales.dispatch.created`. Per-arg ZodValidationPipe; principal
 * from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { DispatchService } from './dispatch.service.js';
import {
  createDispatch,
  createDispatchItem,
  listQuery,
  type CreateDispatch,
  type CreateDispatchItem,
  type ListQuery,
} from '../sales.dtos.js';

@Controller()
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  /* ── dispatch master ──────────────────────────────────────────────── */

  @Permissions('sales:dispatch_master:read')
  @Get('v1/dispatches')
  listDispatches(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.dispatch.listDispatches(query);
  }

  @Permissions('sales:dispatch_master:read')
  @Get('v1/dispatches/:id')
  getDispatch(@Param('id') id: string) {
    return this.dispatch.getDispatch(id);
  }

  /* ── flow: create with items ──────────────────────────────────────── */

  @Permissions('sales:dispatch_master:write')
  @Post('v1/dispatches')
  createDispatch(
    @Body(new ZodValidationPipe(createDispatch)) body: CreateDispatch,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.dispatch.createDispatch(body, principal);
  }

  /* ── dispatch items ───────────────────────────────────────────────── */

  @Permissions('sales:dispatch_items:read')
  @Get('v1/dispatch-items')
  listDispatchItems(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.dispatch.listDispatchItems(query);
  }

  @Permissions('sales:dispatch_items:read')
  @Get('v1/dispatch-items/:id')
  getDispatchItem(@Param('id') id: string) {
    return this.dispatch.getDispatchItem(id);
  }

  @Permissions('sales:dispatch_items:write')
  @Post('v1/dispatch-items')
  createDispatchItem(
    @Body(new ZodValidationPipe(createDispatchItem)) body: CreateDispatchItem,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.dispatch.createDispatchItem(body, principal);
  }
}
