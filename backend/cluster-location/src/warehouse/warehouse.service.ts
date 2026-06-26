/**
 * WarehouseService — CRUD over the warehouse hierarchy tables (WAREHOUSE_TYPE_MASTER,
 * WAREHOUSE_MASTER, FLOOR_MASTER, ZONE_TYPE_MASTER, ZONE_MASTER, RACK_MASTER, SHELF_MASTER,
 * BIN_MASTER). Inserts stamp status="ACTIVE" + created_by/updated_by from the principal;
 * lists are keyset-paginated by desc(pk).
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { LOCATION_DB, locationSchema, type LocationDb } from '../location.tokens.js';
import { paginate, type Page } from '../sites/sites.service.js';
import type {
  CreateBinBody,
  CreateFloorBody,
  CreateRackBody,
  CreateShelfBody,
  CreateWarehouseBody,
  CreateWarehouseTypeBody,
  CreateZoneBody,
  CreateZoneTypeBody,
  ListQuery,
} from '../location.dtos.js';

@Injectable()
export class WarehouseService {
  constructor(@Inject(LOCATION_DB) private readonly db: LocationDb) {}

  /* ── warehouse_type_master ────────────────────────────────────────────────── */

  async createWarehouseType(body: CreateWarehouseTypeBody, principal: AuthPrincipal) {
    const { warehouseTypeMaster } = locationSchema;
    const rows = await this.db
      .insert(warehouseTypeMaster)
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

  async listWarehouseTypes(query: ListQuery): Promise<Page<typeof locationSchema.warehouseTypeMaster.$inferSelect>> {
    const { warehouseTypeMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(warehouseTypeMaster)
      .where(query.cursor ? lt(warehouseTypeMaster.warehouseTypeId, query.cursor) : undefined)
      .orderBy(desc(warehouseTypeMaster.warehouseTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.warehouseTypeId);
  }

  async getWarehouseType(id: string) {
    const { warehouseTypeMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(warehouseTypeMaster)
        .where(eq(warehouseTypeMaster.warehouseTypeId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }

  /* ── warehouse_master ─────────────────────────────────────────────────────── */

  async createWarehouse(body: CreateWarehouseBody, principal: AuthPrincipal) {
    const { warehouseMaster } = locationSchema;
    const rows = await this.db
      .insert(warehouseMaster)
      .values({
        locationId: body.locationId ?? null,
        warehouseTypeId: body.warehouseTypeId ?? null,
        warehouseCode: body.warehouseCode,
        warehouseName: body.warehouseName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listWarehouses(query: ListQuery): Promise<Page<typeof locationSchema.warehouseMaster.$inferSelect>> {
    const { warehouseMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(warehouseMaster)
      .where(query.cursor ? lt(warehouseMaster.warehouseId, query.cursor) : undefined)
      .orderBy(desc(warehouseMaster.warehouseId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.warehouseId);
  }

  async getWarehouse(id: string) {
    const { warehouseMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(warehouseMaster)
        .where(eq(warehouseMaster.warehouseId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }

  /* ── floor_master ─────────────────────────────────────────────────────────── */

  async createFloor(body: CreateFloorBody, principal: AuthPrincipal) {
    const { floorMaster } = locationSchema;
    const rows = await this.db
      .insert(floorMaster)
      .values({
        warehouseId: body.warehouseId ?? null,
        floorCode: body.floorCode,
        floorName: body.floorName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listFloors(query: ListQuery): Promise<Page<typeof locationSchema.floorMaster.$inferSelect>> {
    const { floorMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(floorMaster)
      .where(query.cursor ? lt(floorMaster.floorId, query.cursor) : undefined)
      .orderBy(desc(floorMaster.floorId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.floorId);
  }

  async getFloor(id: string) {
    const { floorMaster } = locationSchema;
    const row = (
      await this.db.select().from(floorMaster).where(eq(floorMaster.floorId, id)).limit(1)
    )[0];
    return row ?? null;
  }

  /* ── zone_type_master ─────────────────────────────────────────────────────── */

  async createZoneType(body: CreateZoneTypeBody, principal: AuthPrincipal) {
    const { zoneTypeMaster } = locationSchema;
    const rows = await this.db
      .insert(zoneTypeMaster)
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

  async listZoneTypes(query: ListQuery): Promise<Page<typeof locationSchema.zoneTypeMaster.$inferSelect>> {
    const { zoneTypeMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(zoneTypeMaster)
      .where(query.cursor ? lt(zoneTypeMaster.zoneTypeId, query.cursor) : undefined)
      .orderBy(desc(zoneTypeMaster.zoneTypeId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.zoneTypeId);
  }

  async getZoneType(id: string) {
    const { zoneTypeMaster } = locationSchema;
    const row = (
      await this.db
        .select()
        .from(zoneTypeMaster)
        .where(eq(zoneTypeMaster.zoneTypeId, id))
        .limit(1)
    )[0];
    return row ?? null;
  }

  /* ── zone_master ──────────────────────────────────────────────────────────── */

  async createZone(body: CreateZoneBody, principal: AuthPrincipal) {
    const { zoneMaster } = locationSchema;
    const rows = await this.db
      .insert(zoneMaster)
      .values({
        floorId: body.floorId ?? null,
        zoneTypeId: body.zoneTypeId ?? null,
        zoneCode: body.zoneCode,
        zoneName: body.zoneName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listZones(query: ListQuery): Promise<Page<typeof locationSchema.zoneMaster.$inferSelect>> {
    const { zoneMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(zoneMaster)
      .where(query.cursor ? lt(zoneMaster.zoneId, query.cursor) : undefined)
      .orderBy(desc(zoneMaster.zoneId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.zoneId);
  }

  async getZone(id: string) {
    const { zoneMaster } = locationSchema;
    const row = (
      await this.db.select().from(zoneMaster).where(eq(zoneMaster.zoneId, id)).limit(1)
    )[0];
    return row ?? null;
  }

  /* ── rack_master ──────────────────────────────────────────────────────────── */

  async createRack(body: CreateRackBody, principal: AuthPrincipal) {
    const { rackMaster } = locationSchema;
    const rows = await this.db
      .insert(rackMaster)
      .values({
        zoneId: body.zoneId ?? null,
        rackCode: body.rackCode,
        rackName: body.rackName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listRacks(query: ListQuery): Promise<Page<typeof locationSchema.rackMaster.$inferSelect>> {
    const { rackMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(rackMaster)
      .where(query.cursor ? lt(rackMaster.rackId, query.cursor) : undefined)
      .orderBy(desc(rackMaster.rackId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.rackId);
  }

  async getRack(id: string) {
    const { rackMaster } = locationSchema;
    const row = (
      await this.db.select().from(rackMaster).where(eq(rackMaster.rackId, id)).limit(1)
    )[0];
    return row ?? null;
  }

  /* ── shelf_master ─────────────────────────────────────────────────────────── */

  async createShelf(body: CreateShelfBody, principal: AuthPrincipal) {
    const { shelfMaster } = locationSchema;
    const rows = await this.db
      .insert(shelfMaster)
      .values({
        rackId: body.rackId ?? null,
        shelfCode: body.shelfCode,
        shelfName: body.shelfName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listShelves(query: ListQuery): Promise<Page<typeof locationSchema.shelfMaster.$inferSelect>> {
    const { shelfMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(shelfMaster)
      .where(query.cursor ? lt(shelfMaster.shelfId, query.cursor) : undefined)
      .orderBy(desc(shelfMaster.shelfId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.shelfId);
  }

  async getShelf(id: string) {
    const { shelfMaster } = locationSchema;
    const row = (
      await this.db.select().from(shelfMaster).where(eq(shelfMaster.shelfId, id)).limit(1)
    )[0];
    return row ?? null;
  }

  /* ── bin_master ───────────────────────────────────────────────────────────── */

  async createBin(body: CreateBinBody, principal: AuthPrincipal) {
    const { binMaster } = locationSchema;
    const rows = await this.db
      .insert(binMaster)
      .values({
        shelfId: body.shelfId ?? null,
        binCode: body.binCode,
        binName: body.binName,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async listBins(query: ListQuery): Promise<Page<typeof locationSchema.binMaster.$inferSelect>> {
    const { binMaster } = locationSchema;
    const rows = await this.db
      .select()
      .from(binMaster)
      .where(query.cursor ? lt(binMaster.binId, query.cursor) : undefined)
      .orderBy(desc(binMaster.binId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.binId);
  }

  async getBin(id: string) {
    const { binMaster } = locationSchema;
    const row = (
      await this.db.select().from(binMaster).where(eq(binMaster.binId, id)).limit(1)
    )[0];
    return row ?? null;
  }
}
