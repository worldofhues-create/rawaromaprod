/**
 * MastersController — REST over the sales reference masters (customer_master,
 * transporter_master). Reads require `sales:<table>:read`, writes `:write`. Per-arg
 * ZodValidationPipe; principal from the token.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { MastersService } from './masters.service.js';
import {
  createCustomer,
  createTransporter,
  listQuery,
  type CreateCustomer,
  type CreateTransporter,
  type ListQuery,
} from '../sales.dtos.js';

@Controller()
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  /* ── customer master ──────────────────────────────────────────────── */

  @Permissions('sales:customer_master:read')
  @Get('v1/customers')
  listCustomers(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.masters.listCustomers(query);
  }

  @Permissions('sales:customer_master:read')
  @Get('v1/customers/:id')
  getCustomer(@Param('id') id: string) {
    return this.masters.getCustomer(id);
  }

  @Permissions('sales:customer_master:write')
  @Post('v1/customers')
  createCustomer(
    @Body(new ZodValidationPipe(createCustomer)) body: CreateCustomer,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.masters.createCustomer(body, principal);
  }

  /* ── transporter master ───────────────────────────────────────────── */

  @Permissions('sales:transporter_master:read')
  @Get('v1/transporters')
  listTransporters(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.masters.listTransporters(query);
  }

  @Permissions('sales:transporter_master:read')
  @Get('v1/transporters/:id')
  getTransporter(@Param('id') id: string) {
    return this.masters.getTransporter(id);
  }

  @Permissions('sales:transporter_master:write')
  @Post('v1/transporters')
  createTransporter(
    @Body(new ZodValidationPipe(createTransporter)) body: CreateTransporter,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.masters.createTransporter(body, principal);
  }
}
