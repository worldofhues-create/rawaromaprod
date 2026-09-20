/**
 * SitesService — CRUD over the site tables (LOCATION_TYPE_MASTER, LOCATION_MASTER).
 * Inserts stamp status="ACTIVE" + created_by/updated_by from the verified principal.
 * Lists are keyset-paginated: order by desc(pk), fetch limit+1, return the trailing id
 * as the next cursor.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { LOCATION_DB, locationSchema, type LocationDb } from '../location.tokens.js';
import type {
  CreateLocationBody,
  CreateLocationTypeBody,
  ListQuery,
} from '../location.dtos.js';

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class SitesService {
  constructor(@Inject(LOCATION_DB) private readonly db: LocationDb) {}

  /* ── location_type_master ─────────────────────────────────────────────────── */

  async createLocationType(body: CreateLocationTypeBody, principal: AuthPrincipal) {
    const { locationTypeMaster } = locationSchema;
    const rows = await this.db
      .insert(locationTypeMaster)
      .values({
        typeCode: body.typeCode,
        typeName: body.typeName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listLocationTypes(query: ListQuery): Promise<Page<typeof locationSchema.locationTypeMaster.$inferSelect>> {
    const { locationTypeMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(locationTypeMaster)
      .where(query.cursor ? lt(locationTypeMaster.locationTypeId, query.cursor) : undefined)
      .orderBy(desc(locationTypeMaster.locationTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.locationTypeId);
  }

  async getLocationType(id: string) {
    const { locationTypeMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(locationTypeMaster)
        .where(eq(locationTypeMaster.locationTypeId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }

  /* ── location_master ──────────────────────────────────────────────────────── */

  async createLocation(body: CreateLocationBody, principal: AuthPrincipal) {
    const { locationMaster } = locationSchema;
    const rows = await this.db
      .insert(locationMaster)
      .values({
        organizationId: body.organizationId ?? null,
        businessUnitId: body.businessUnitId ?? null,
        parentLocationId: body.parentLocationId ?? null,
        locationTypeId: body.locationTypeId ?? null,
        locationCode: body.locationCode,
        locationName: body.locationName,
        addressId: body.addressId ?? null,
        geoLocationId: body.geoLocationId ?? null,
        primaryContactId: body.primaryContactId ?? null,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listLocations(query: ListQuery): Promise<Page<typeof locationSchema.locationMaster.$inferSelect>> {
    const { locationMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(locationMaster)
      .where(query.cursor ? lt(locationMaster.locationId, query.cursor) : undefined)
      .orderBy(desc(locationMaster.locationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.locationId);
  }

  async getLocation(id: string) {
    const { locationMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(locationMaster)
        .where(eq(locationMaster.locationId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }
}

/** Keyset page helper: trims the limit+1 probe row and derives the next cursor. */
function paginate<T>(rows: T[], limit: number, idOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? idOf(last) : null;
  return { items, nextCursor };
}

export { paginate };
export type { Page };
