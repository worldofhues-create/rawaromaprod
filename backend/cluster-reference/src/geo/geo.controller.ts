/**
 * GeoController — REST over the geo/locale reference masters. Reads require the
 * `platform:<table>:read` permission, writes the `:write`. Query + body validated per-arg
 * via ZodValidationPipe; the verified principal is read from the token on writes.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  CurrentUser,
  Permissions,
  ZodValidationPipe,
  type AuthPrincipal,
} from '@core/backend-kernel';
import { GeoService } from './geo.service.js';
import {
  createAddress,
  createContact,
  createCountry,
  createCurrency,
  createGeoLocation,
  createLanguage,
  createTimezone,
  listQuery,
  type CreateAddress,
  type CreateContact,
  type CreateCountry,
  type CreateCurrency,
  type CreateGeoLocation,
  type CreateLanguage,
  type CreateTimezone,
  type ListQuery,
} from '../reference.dtos.js';

@Controller()
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /* ── country ──────────────────────────────────────────────────────── */

  @Permissions('platform:country_master:read')
  @Get('v1/countries')
  listCountries(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.geo.listCountries(query);
  }

  @Permissions('platform:country_master:read')
  @Get('v1/countries/:id')
  getCountry(@Param('id') id: string) {
    return this.geo.getCountry(id);
  }

  @Permissions('platform:country_master:write')
  @Post('v1/countries')
  createCountry(
    @Body(new ZodValidationPipe(createCountry)) body: CreateCountry,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.geo.createCountry(body, principal);
  }

  /* ── currency ─────────────────────────────────────────────────────── */

  @Permissions('platform:currency_master:read')
  @Get('v1/currencies')
  listCurrencies(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.geo.listCurrencies(query);
  }

  @Permissions('platform:currency_master:read')
  @Get('v1/currencies/:id')
  getCurrency(@Param('id') id: string) {
    return this.geo.getCurrency(id);
  }

  @Permissions('platform:currency_master:write')
  @Post('v1/currencies')
  createCurrency(
    @Body(new ZodValidationPipe(createCurrency)) body: CreateCurrency,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.geo.createCurrency(body, principal);
  }

  /* ── language ─────────────────────────────────────────────────────── */

  @Permissions('platform:language_master:read')
  @Get('v1/languages')
  listLanguages(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.geo.listLanguages(query);
  }

  @Permissions('platform:language_master:read')
  @Get('v1/languages/:id')
  getLanguage(@Param('id') id: string) {
    return this.geo.getLanguage(id);
  }

  @Permissions('platform:language_master:write')
  @Post('v1/languages')
  createLanguage(
    @Body(new ZodValidationPipe(createLanguage)) body: CreateLanguage,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.geo.createLanguage(body, principal);
  }

  /* ── timezone ─────────────────────────────────────────────────────── */

  @Permissions('platform:timezone_master:read')
  @Get('v1/timezones')
  listTimezones(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.geo.listTimezones(query);
  }

  @Permissions('platform:timezone_master:read')
  @Get('v1/timezones/:id')
  getTimezone(@Param('id') id: string) {
    return this.geo.getTimezone(id);
  }

  @Permissions('platform:timezone_master:write')
  @Post('v1/timezones')
  createTimezone(
    @Body(new ZodValidationPipe(createTimezone)) body: CreateTimezone,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.geo.createTimezone(body, principal);
  }

  /* ── address ──────────────────────────────────────────────────────── */

  @Permissions('platform:address_master:read')
  @Get('v1/addresses')
  listAddresses(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.geo.listAddresses(query);
  }

  @Permissions('platform:address_master:read')
  @Get('v1/addresses/:id')
  getAddress(@Param('id') id: string) {
    return this.geo.getAddress(id);
  }

  @Permissions('platform:address_master:write')
  @Post('v1/addresses')
  createAddress(
    @Body(new ZodValidationPipe(createAddress)) body: CreateAddress,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.geo.createAddress(body, principal);
  }

  /* ── geo location ─────────────────────────────────────────────────── */

  @Permissions('platform:geo_location_master:read')
  @Get('v1/geo-locations')
  listGeoLocations(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.geo.listGeoLocations(query);
  }

  @Permissions('platform:geo_location_master:read')
  @Get('v1/geo-locations/:id')
  getGeoLocation(@Param('id') id: string) {
    return this.geo.getGeoLocation(id);
  }

  @Permissions('platform:geo_location_master:write')
  @Post('v1/geo-locations')
  createGeoLocation(
    @Body(new ZodValidationPipe(createGeoLocation)) body: CreateGeoLocation,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.geo.createGeoLocation(body, principal);
  }

  /* ── contact ──────────────────────────────────────────────────────── */

  @Permissions('platform:contact_master:read')
  @Get('v1/contacts')
  listContacts(@Query(new ZodValidationPipe(listQuery)) query: ListQuery) {
    return this.geo.listContacts(query);
  }

  @Permissions('platform:contact_master:read')
  @Get('v1/contacts/:id')
  getContact(@Param('id') id: string) {
    return this.geo.getContact(id);
  }

  @Permissions('platform:contact_master:write')
  @Post('v1/contacts')
  createContact(
    @Body(new ZodValidationPipe(createContact)) body: CreateContact,
    @CurrentUser() principal: AuthPrincipal,
  ) {
    return this.geo.createContact(body, principal);
  }
}
