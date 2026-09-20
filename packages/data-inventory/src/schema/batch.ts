/**
 * RM batch + genealogy tables (Phase-1A Data Dictionary, schema `inventory`):
 * RM_BATCH_MASTER, BATCH_CONTAINER_MAPPINGS, BATCH_GENEALOGY_HISTORY. Per the dictionary
 * ALL refs here are SOFT (grn_item_id, grn_container_id, finished_good/oil/rm batch refs,
 * material/location) → plain uuid, no in-schema FK promotion.
 */
import { date, index, numeric, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { inventory } from "./_schema.js";

/** RM_BATCH_MASTER — grn_item_id is dict-soft → plain uuid. */
export const rmBatchMaster = inventory.table(
  "rm_batch_master",
  {
    rmBatchId: dictPk("rm_batch_id"),
    grnItemId: uuid("grn_item_id"),
    materialId: uuid("material_id"),
    batchNumber: varchar("batch_number", { length: 50 }),
    manufacturingDate: date("manufacturing_date"),
    expiryDate: date("expiry_date"),
    receivedQty: numeric("received_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    storageLocationId: uuid("storage_location_id"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("rm_batch_master_number_uq").on(t.batchNumber),
    index("rm_batch_master_grn_item_idx").on(t.grnItemId),
    index("rm_batch_master_material_idx").on(t.materialId),
    index("rm_batch_master_storage_location_idx").on(t.storageLocationId),
  ],
);

/** BATCH_CONTAINER_MAPPINGS — both refs dict-soft → plain uuid. */
export const batchContainerMappings = inventory.table(
  "batch_container_mappings",
  {
    batchContainerMappingId: dictPk("batch_container_mapping_id"),
    rmBatchId: uuid("rm_batch_id"),
    grnContainerId: uuid("grn_container_id"),
    ...metaColumns(),
  },
  (t) => [
    index("batch_container_mappings_rm_batch_idx").on(t.rmBatchId),
    index("batch_container_mappings_grn_container_idx").on(t.grnContainerId),
  ],
);

/** BATCH_GENEALOGY_HISTORY — all batch refs dict-soft → plain uuid. */
export const batchGenealogyHistory = inventory.table(
  "batch_genealogy_history",
  {
    batchGenealogyHistoryId: dictPk("batch_genealogy_history_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id"),
    oilBatchId: uuid("oil_batch_id"),
    rmBatchId: uuid("rm_batch_id"),
    relationshipType: varchar("relationship_type", { length: 30 }),
    recordedDt: timestamp("recorded_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("batch_genealogy_history_fg_batch_idx").on(t.finishedGoodBatchId),
    index("batch_genealogy_history_oil_batch_idx").on(t.oilBatchId),
    index("batch_genealogy_history_rm_batch_idx").on(t.rmBatchId),
  ],
);
