/**
 * VendorController — REST over the vendor masters. Reads require
 * `procurement:<table>:read`, writes `:write`. Per-arg ZodValidationPipe; principal from
 * the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { VendorService } from './vendor.service.js';
import {
  createVendorContact,
  createVendorDetails,
  createVendorRmMapping,
  listQuery,
  type CreateVendorContact,
  type CreateVendorDetails,
  type CreateVendorRmMapping,
  type ListQuery,
} from '../cluster-procurement.dtos.js';

@Controller()
export class VendorController {
  constructor(private readonly vendors: VendorService) {}

  /* ── vendor_details ─────────────────────────────────────────────────── */

  @Permissions('procurement:vendor_details:read')
  @Get('v1/vendors')
  listVendorDetails(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.vendors.listVendorDetails(query);
  }

  @Permissions('procurement:vendor_details:read')
  @Get('v1/vendors/:id')
  getVendorDetails(@Param('id') id: string) {
    return this.vendors.getVendorDetails(id);
  }

  @Permissions('procurement:vendor_details:write')
  @Post('v1/vendors')
  createVendorDetails(
    @Body(new ZodValidationPipe(createVendorDetails)) body: CreateVendorDetails,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.vendors.createVendorDetails(body, principal);
  }

  /* ── vendor_contact ─────────────────────────────────────────────────── */

  @Permissions('procurement:vendor_contact:read')
  @Get('v1/vendor-contacts')
  listVendorContacts(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.vendors.listVendorContacts(query);
  }

  @Permissions('procurement:vendor_contact:read')
  @Get('v1/vendor-contacts/:id')
  getVendorContact(@Param('id') id: string) {
    return this.vendors.getVendorContact(id);
  }

  @Permissions('procurement:vendor_contact:write')
  @Post('v1/vendor-contacts')
  createVendorContact(
    @Body(new ZodValidationPipe(createVendorContact)) body: CreateVendorContact,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.vendors.createVendorContact(body, principal);
  }

  /* ── vendor_rm_mapping ──────────────────────────────────────────────── */

  @Permissions('procurement:vendor_rm_mapping:read')
  @Get('v1/vendor-rm-mappings')
  listVendorRmMappings(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.vendors.listVendorRmMappings(query);
  }

  @Permissions('procurement:vendor_rm_mapping:read')
  @Get('v1/vendor-rm-mappings/:id')
  getVendorRmMapping(@Param('id') id: string) {
    return this.vendors.getVendorRmMapping(id);
  }

  @Permissions('procurement:vendor_rm_mapping:write')
  @Post('v1/vendor-rm-mappings')
  createVendorRmMapping(
    @Body(new ZodValidationPipe(createVendorRmMapping)) body: CreateVendorRmMapping,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.vendors.createVendorRmMapping(body, principal);
  }
}
