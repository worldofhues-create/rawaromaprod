/**
 * Warehouse hierarchy tables (Phase-1A Data Dictionary): WAREHOUSE_TYPE_MASTER,
 * WAREHOUSE_MASTER, FLOOR_MASTER, ZONE_TYPE_MASTER, ZONE_MASTER, RACK_MASTER, SHELF_MASTER,
 * BIN_MASTER. Explicit in-schema FK chain warehouse→floor→zone→rack→shelf→bin. warehouse
 * also FKs location_master.
 */
import { index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { location } from "./_schema.js";
import { locationMaster } from "./location.js";

/** WAREHOUSE_TYPE_MASTER */
export const warehouseTypeMaster = location.table(
  "warehouse_type_master",
  {
    warehouseTypeId: dictPk("warehouse_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("warehouse_type_master_code_uq").on(t.typeCode)],
);

/** WAREHOUSE_MASTER */
export const warehouseMaster = location.table(
  "warehouse_master",
  {
    warehouseId: dictPk("warehouse_id"),
    locationId: uuid("location_id").references(() => locationMaster.locationId),
    warehouseTypeId: uuid("warehouse_type_id").references(
      () => warehouseTypeMaster.warehouseTypeId,
    ),
    warehouseCode: varchar("warehouse_code", { length: 50 }),
    warehouseName: varchar("warehouse_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("warehouse_master_code_uq").on(t.warehouseCode),
    index("warehouse_master_location_idx").on(t.locationId),
    index("warehouse_master_type_idx").on(t.warehouseTypeId),
  ],
);

/** FLOOR_MASTER */
export const floorMaster = location.table(
  "floor_master",
  {
    floorId: dictPk("floor_id"),
    warehouseId: uuid("warehouse_id").references(() => warehouseMaster.warehouseId),
    floorCode: varchar("floor_code", { length: 50 }),
    floorName: varchar("floor_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("floor_master_code_uq").on(t.floorCode),
    index("floor_master_warehouse_idx").on(t.warehouseId),
  ],
);

/** ZONE_TYPE_MASTER */
export const zoneTypeMaster = location.table(
  "zone_type_master",
  {
    zoneTypeId: dictPk("zone_type_id"),
    typeCode: varchar("type_code", { length: 50 }),
    typeName: varchar("type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("zone_type_master_code_uq").on(t.typeCode)],
);

/** ZONE_MASTER */
export const zoneMaster = location.table(
  "zone_master",
  {
    zoneId: dictPk("zone_id"),
    floorId: uuid("floor_id").references(() => floorMaster.floorId),
    zoneTypeId: uuid("zone_type_id").references(() => zoneTypeMaster.zoneTypeId),
    zoneCode: varchar("zone_code", { length: 50 }),
    zoneName: varchar("zone_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("zone_master_code_uq").on(t.zoneCode),
    index("zone_master_floor_idx").on(t.floorId),
    index("zone_master_type_idx").on(t.zoneTypeId),
  ],
);

/** RACK_MASTER */
export const rackMaster = location.table(
  "rack_master",
  {
    rackId: dictPk("rack_id"),
    zoneId: uuid("zone_id").references(() => zoneMaster.zoneId),
    rackCode: varchar("rack_code", { length: 50 }),
    rackName: varchar("rack_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("rack_master_code_uq").on(t.rackCode),
    index("rack_master_zone_idx").on(t.zoneId),
  ],
);

/** SHELF_MASTER */
export const shelfMaster = location.table(
  "shelf_master",
  {
    shelfId: dictPk("shelf_id"),
    rackId: uuid("rack_id").references(() => rackMaster.rackId),
    shelfCode: varchar("shelf_code", { length: 50 }),
    shelfName: varchar("shelf_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("shelf_master_code_uq").on(t.shelfCode),
    index("shelf_master_rack_idx").on(t.rackId),
  ],
);

/** BIN_MASTER */
export const binMaster = location.table(
  "bin_master",
  {
    binId: dictPk("bin_id"),
    shelfId: uuid("shelf_id").references(() => shelfMaster.shelfId),
    binCode: varchar("bin_code", { length: 50 }),
    binName: varchar("bin_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("bin_master_code_uq").on(t.binCode),
    index("bin_master_shelf_idx").on(t.shelfId),
  ],
);
