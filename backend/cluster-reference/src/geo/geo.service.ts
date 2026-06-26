/**
 * GeoService — CRUD over the geo/locale reference masters: COUNTRY, CURRENCY, LANGUAGE,
 * TIMEZONE, ADDRESS, GEO_LOCATION, CONTACT. Each create stamps status "ACTIVE" and
 * created_by/updated_by from the principal; each list is cursor-paginated by descending PK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { REFERENCE_DB, referenceSchema, type ReferenceDb } from '../reference.tokens.js';
import type {
  CreateAddress,
  CreateContact,
  CreateCountry,
  CreateCurrency,
  CreateGeoLocation,
  CreateLanguage,
  CreateTimezone,
  ListQuery,
} from '../reference.dtos.js';

const {
  countryMaster,
  currencyMaster,
  languageMaster,
  timezoneMaster,
  addressMaster,
  geoLocationMaster,
  contactMaster,
} = referenceSchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class GeoService {
  constructor(@Inject(REFERENCE_DB) private readonly db: ReferenceDb) {}

  /* ── country ──────────────────────────────────────────────────────── */

  async createCountry(body: CreateCountry, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(countryMaster)
        .values({
          countryCode: body.countryCode,
          countryName: body.countryName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: country_master');
    return row;
  }

  async listCountries(query: ListQuery): Promise<Page<typeof countryMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(countryMaster)
      .where(query.cursor ? lt(countryMaster.countryId, query.cursor) : undefined)
      .orderBy(desc(countryMaster.countryId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.countryId);
  }

  async getCountry(id: string) {
    return (
      await this.db.select().from(countryMaster).where(eq(countryMaster.countryId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── currency ─────────────────────────────────────────────────────── */

  async createCurrency(body: CreateCurrency, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(currencyMaster)
        .values({
          currencyCode: body.currencyCode,
          currencyName: body.currencyName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: currency_master');
    return row;
  }

  async listCurrencies(query: ListQuery): Promise<Page<typeof currencyMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(currencyMaster)
      .where(query.cursor ? lt(currencyMaster.currencyId, query.cursor) : undefined)
      .orderBy(desc(currencyMaster.currencyId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.currencyId);
  }

  async getCurrency(id: string) {
    return (
      await this.db.select().from(currencyMaster).where(eq(currencyMaster.currencyId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── language ─────────────────────────────────────────────────────── */

  async createLanguage(body: CreateLanguage, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(languageMaster)
        .values({
          languageCode: body.languageCode,
          languageName: body.languageName,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: language_master');
    return row;
  }

  async listLanguages(query: ListQuery): Promise<Page<typeof languageMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(languageMaster)
      .where(query.cursor ? lt(languageMaster.languageId, query.cursor) : undefined)
      .orderBy(desc(languageMaster.languageId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.languageId);
  }

  async getLanguage(id: string) {
    return (
      await this.db.select().from(languageMaster).where(eq(languageMaster.languageId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── timezone ─────────────────────────────────────────────────────── */

  async createTimezone(body: CreateTimezone, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(timezoneMaster)
        .values({
          timezoneCode: body.timezoneCode,
          utcOffset: body.utcOffset,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: timezone_master');
    return row;
  }

  async listTimezones(query: ListQuery): Promise<Page<typeof timezoneMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(timezoneMaster)
      .where(query.cursor ? lt(timezoneMaster.timezoneId, query.cursor) : undefined)
      .orderBy(desc(timezoneMaster.timezoneId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.timezoneId);
  }

  async getTimezone(id: string) {
    return (
      await this.db.select().from(timezoneMaster).where(eq(timezoneMaster.timezoneId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── address ──────────────────────────────────────────────────────── */

  async createAddress(body: CreateAddress, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(addressMaster)
        .values({
          addressLine1: body.addressLine1,
          addressLine2: body.addressLine2 ?? null,
          city: body.city,
          stateName: body.stateName,
          countryId: body.countryId ?? null,
          pincode: body.pincode,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: address_master');
    return row;
  }

  async listAddresses(query: ListQuery): Promise<Page<typeof addressMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(addressMaster)
      .where(query.cursor ? lt(addressMaster.addressId, query.cursor) : undefined)
      .orderBy(desc(addressMaster.addressId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.addressId);
  }

  async getAddress(id: string) {
    return (
      await this.db.select().from(addressMaster).where(eq(addressMaster.addressId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── geo location ─────────────────────────────────────────────────── */

  async createGeoLocation(body: CreateGeoLocation, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(geoLocationMaster)
        .values({
          latitude: String(body.latitude),
          longitude: String(body.longitude),
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: geo_location_master');
    return row;
  }

  async listGeoLocations(query: ListQuery): Promise<Page<typeof geoLocationMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(geoLocationMaster)
      .where(query.cursor ? lt(geoLocationMaster.geoLocationId, query.cursor) : undefined)
      .orderBy(desc(geoLocationMaster.geoLocationId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.geoLocationId);
  }

  async getGeoLocation(id: string) {
    return (
      await this.db
        .select()
        .from(geoLocationMaster)
        .where(eq(geoLocationMaster.geoLocationId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── contact ──────────────────────────────────────────────────────── */

  async createContact(body: CreateContact, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(contactMaster)
        .values({
          contactName: body.contactName,
          email: body.email,
          mobileNumber: body.mobileNumber,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: contact_master');
    return row;
  }

  async listContacts(query: ListQuery): Promise<Page<typeof contactMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(contactMaster)
      .where(query.cursor ? lt(contactMaster.contactId, query.cursor) : undefined)
      .orderBy(desc(contactMaster.contactId))
      .limit(query.limit + 1);
    return this.paginate(rows, query.limit, (r) => r.contactId);
  }

  async getContact(id: string) {
    return (
      await this.db.select().from(contactMaster).where(eq(contactMaster.contactId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── shared cursor pagination ─────────────────────────────────────── */

  private paginate<T>(rows: T[], limit: number, pk: (row: T) => string): Page<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? pk(last) : null;
    return { items, nextCursor };
  }
}
