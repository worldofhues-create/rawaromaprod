/**
 * StorageService — CRUD over the storage-location tables (STORAGE_LOCATION_TYPE_MASTER,
 * STORAGE_LOCATION_STATUS_MASTER, STORAGE_LOCATION_MASTER). Inserts stamp status="ACTIVE"
 * + created_by/updated_by from the principal; lists are keyset-paginated by desc(pk).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { LOCATION_DB, locationSchema, type LocationDb } from '../location.tokens.js';
import { paginate, type Page } from '../sites/sites.service.js';
import type {
  CreateStorageLocationBody,
  CreateStorageLocationStatusBody,
  CreateStorageLocationTypeBody,
  ListQuery,
} from '../location.dtos.js';

@Injectable()
export class StorageService {
  constructor(@Inject(LOCATION_DB) private readonly db: LocationDb) {}

  /* ── storage_location_type_master ─────────────────────────────────────────── */

  async createStorageLocationType(
    body: CreateStorageLocationTypeBody,
    principal: AuthPrincipal,
  ) {
    const { storageLocationTypeMaster } = locationSchema;
    const rows = await this.db
      .insert(storageLocationTypeMaster)
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

  async listStorageLocationTypes(query: ListQuery): Promise<Page<typeof locationSchema.storageLocationTypeMaster.$inferSelect>> {
    const { storageLocationTypeMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(storageLocationTypeMaster)
      .where(
        query.cursor
          ? lt(storageLocationTypeMaster.storageLocationTypeId, query.cursor)
          : undefined,
      )
      .orderBy(desc(storageLocationTypeMaster.storageLocationTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.storageLocationTypeId);
  }

  async getStorageLocationType(id: string) {
    const { storageLocationTypeMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(storageLocationTypeMaster)
        .where(eq(storageLocationTypeMaster.storageLocationTypeId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }

  /* ── storage_location_status_master ───────────────────────────────────────── */

  async createStorageLocationStatus(
    body: CreateStorageLocationStatusBody,
    principal: AuthPrincipal,
  ) {
    const { storageLocationStatusMaster } = locationSchema;
    const rows = await this.db
      .insert(storageLocationStatusMaster)
      .values({
        statusCode: body.statusCode,
        statusName: body.statusName,
        description: body.description ?? null,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listStorageLocationStatuses(query: ListQuery): Promise<Page<typeof locationSchema.storageLocationStatusMaster.$inferSelect>> {
    const { storageLocationStatusMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(storageLocationStatusMaster)
      .where(
        query.cursor
          ? lt(storageLocationStatusMaster.storageLocationStatusId, query.cursor)
          : undefined,
      )
      .orderBy(desc(storageLocationStatusMaster.storageLocationStatusId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.storageLocationStatusId);
  }

  async getStorageLocationStatus(id: string) {
    const { storageLocationStatusMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(storageLocationStatusMaster)
        .where(eq(storageLocationStatusMaster.storageLocationStatusId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }

  /* ── storage_location_master ──────────────────────────────────────────────── */

  async createStorageLocation(body: CreateStorageLocationBody, principal: AuthPrincipal) {
    const { storageLocationMaster } = locationSchema;
    const rows = await this.db
      .insert(storageLocationMaster)
      .values({
        warehouseId: body.warehouseId ?? null,
        floorId: body.floorId ?? null,
        zoneId: body.zoneId ?? null,
        rackId: body.rackId ?? null,
        shelfId: body.shelfId ?? null,
        binId: body.binId ?? null,
        storageLocationCode: body.storageLocationCode,
        storageLocationName: body.storageLocationName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listStorageLocations(query: ListQuery): Promise<Page<typeof locationSchema.storageLocationMaster.$inferSelect>> {
    const { storageLocationMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(storageLocationMaster)
      .where(
        query.cursor
          ? lt(storageLocationMaster.storageLocationId, query.cursor)
          : undefined,
      )
      .orderBy(desc(storageLocationMaster.storageLocationId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.storageLocationId);
  }

  async getStorageLocation(id: string) {
    const { storageLocationMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(storageLocationMaster)
        .where(eq(storageLocationMaster.storageLocationId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
