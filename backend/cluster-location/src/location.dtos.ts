/**
 * location cluster DTOs — zod schemas for the CRUD boundary (one create body per table +
 * a generic list query). Bodies carry only the dictionary columns; the service stamps the
 * meta tail (status / created_by / updated_by). Validated at the edge via ZodValidationPipe.
 */
import { z } from 'zod';

/** Generic cursor list query: opaque cursor + a 1..100 page size (coerced, default 20). */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/* ── sites ─────────────────────────────────────────────────────────────────── */

export const createLocationTypeBody = z.object({
  typeCode: z.string().max(50),
  typeName: z.string().max(200),
});
export type CreateLocationTypeBody = z.infer<typeof createLocationTypeBody>;

export const createLocationBody = z.object({
  organizationId: z.string().uuid().optional(),
  businessUnitId: z.string().uuid().optional(),
  parentLocationId: z.string().uuid().optional(),
  locationTypeId: z.string().uuid().optional(),
  locationCode: z.string().max(50),
  locationName: z.string().max(200),
  addressId: z.string().uuid().optional(),
  geoLocationId: z.string().uuid().optional(),
  primaryContactId: z.string().uuid().optional(),
});
export type CreateLocationBody = z.infer<typeof createLocationBody>;

/* ── warehouse hierarchy ─────────────────────────────────────────────────────── */

export const createWarehouseTypeBody = z.object({
  typeCode: z.string().max(50),
  typeName: z.string().max(200),
});
export type CreateWarehouseTypeBody = z.infer<typeof createWarehouseTypeBody>;

export const createWarehouseBody = z.object({
  locationId: z.string().uuid().optional(),
  warehouseTypeId: z.string().uuid().optional(),
  warehouseCode: z.string().max(50),
  warehouseName: z.string().max(200),
});
export type CreateWarehouseBody = z.infer<typeof createWarehouseBody>;

export const createFloorBody = z.object({
  warehouseId: z.string().uuid().optional(),
  floorCode: z.string().max(50),
  floorName: z.string().max(200),
});
export type CreateFloorBody = z.infer<typeof createFloorBody>;

export const createZoneTypeBody = z.object({
  typeCode: z.string().max(50),
  typeName: z.string().max(200),
});
export type CreateZoneTypeBody = z.infer<typeof createZoneTypeBody>;

export const createZoneBody = z.object({
  floorId: z.string().uuid().optional(),
  zoneTypeId: z.string().uuid().optional(),
  zoneCode: z.string().max(50),
  zoneName: z.string().max(200),
});
export type CreateZoneBody = z.infer<typeof createZoneBody>;

export const createRackBody = z.object({
  zoneId: z.string().uuid().optional(),
  rackCode: z.string().max(50),
  rackName: z.string().max(200),
});
export type CreateRackBody = z.infer<typeof createRackBody>;

export const createShelfBody = z.object({
  rackId: z.string().uuid().optional(),
  shelfCode: z.string().max(50),
  shelfName: z.string().max(200),
});
export type CreateShelfBody = z.infer<typeof createShelfBody>;

export const createBinBody = z.object({
  shelfId: z.string().uuid().optional(),
  binCode: z.string().max(50),
  binName: z.string().max(200),
});
export type CreateBinBody = z.infer<typeof createBinBody>;

/* ── storage locations ───────────────────────────────────────────────────────── */

export const createStorageLocationTypeBody = z.object({
  typeCode: z.string().max(50),
  typeName: z.string().max(200),
});
export type CreateStorageLocationTypeBody = z.infer<typeof createStorageLocationTypeBody>;

export const createStorageLocationStatusBody = z.object({
  statusCode: z.string().max(50),
  statusName: z.string().max(200),
  description: z.string().optional(),
});
export type CreateStorageLocationStatusBody = z.infer<typeof createStorageLocationStatusBody>;

export const createStorageLocationBody = z.object({
  warehouseId: z.string().uuid().optional(),
  floorId: z.string().uuid().optional(),
  zoneId: z.string().uuid().optional(),
  rackId: z.string().uuid().optional(),
  shelfId: z.string().uuid().optional(),
  binId: z.string().uuid().optional(),
  storageLocationCode: z.string().max(50),
  storageLocationName: z.string().max(200),
});
export type CreateStorageLocationBody = z.infer<typeof createStorageLocationBody>;
