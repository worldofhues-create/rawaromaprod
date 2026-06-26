/**
 * Storage-location tables (Phase-1A Data Dictionary): STORAGE_LOCATION_TYPE_MASTER,
 * STORAGE_LOCATION_STATUS_MASTER, STORAGE_LOCATION_MASTER. storage_location_master FKs the
 * full warehouse hierarchy (warehouse/floor/zone/rack/shelf/bin), all in-schema.
 */
import { index, uniqueIndex, uuid, varchar, text } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { location } from "./_schema.js";
import {
  warehouseMaster,
  floorMaster,
  zoneMaster,
  rackMaster,
  shelfMaster,
  binMaster,
} from "./warehouse.js";

/** STORAGE_LOCATION_TYPE_MASTER */
export const storageLocationTypeMaster = location.table(
  "storage_location_type_master",
  {
    storageLocationTypeId: dictPk("storage_location_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("storage_location_type_master_code_uq").on(t.typeCode)],
);

/** STORAGE_LOCATION_STATUS_MASTER */
export const storageLocationStatusMaster = location.table(
  "storage_location_status_master",
  {
    storageLocationStatusId: dictPk("storage_location_status_id"),
    statusCode: varchar("status_code", { length: 50 }),
    statusName: varchar("status_name", { length: 200 }),
    description: text("description"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("storage_location_status_master_code_uq").on(t.statusCode)],
);

/** STORAGE_LOCATION_MASTER */
export const storageLocationMaster = location.table(
  "storage_location_master",
  {
    storageLocationId: dictPk("storage_location_id"),
    warehouseId: uuid("warehouse_id").references(() => warehouseMaster.warehouseId),
    floorId: uuid("floor_id").references(() => floorMaster.floorId),
    zoneId: uuid("zone_id").references(() => zoneMaster.zoneId),
    rackId: uuid("rack_id").references(() => rackMaster.rackId),
    shelfId: uuid("shelf_id").references(() => shelfMaster.shelfId),
    binId: uuid("bin_id").references(() => binMaster.binId),
    storageLocationCode: varchar("storage_location_code", { length: 50 }),
    storageLocationName: varchar("storage_location_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("storage_location_master_code_uq").on(t.storageLocationCode),
    index("storage_location_master_warehouse_idx").on(t.warehouseId),
    index("storage_location_master_floor_idx").on(t.floorId),
    index("storage_location_master_zone_idx").on(t.zoneId),
    index("storage_location_master_rack_idx").on(t.rackId),
    index("storage_location_master_shelf_idx").on(t.shelfId),
    index("storage_location_master_bin_idx").on(t.binId),
  ],
);
