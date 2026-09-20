/**
 * GRN tables (Phase-1A Data Dictionary, schema `inventory`): GRN_MASTER, GRN_ITEMS,
 * GRN_CONTAINER. In-schema FKs: grn_items → grn_master; grn_container → grn_master + grn_items.
 * gate_entry_id, po/vendor/location/material refs are SOFT (plain uuid).
 */
import { date, index, numeric, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { inventory } from "./_schema.js";

/** GRN_MASTER */
export const grnMaster = inventory.table(
  "grn_master",
  {
    grnId: dictPk("grn_id"),
    grnNumber: varchar("grn_number", { length: 50 }),
    gateEntryId: uuid("gate_entry_id"),
    purchaseOrderId: uuid("purchase_order_id"),
    vendorId: uuid("vendor_id"),
    locationId: uuid("location_id"),
    grnDate: date("grn_date"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("grn_master_number_uq").on(t.grnNumber),
    index("grn_master_gate_entry_idx").on(t.gateEntryId),
    index("grn_master_po_idx").on(t.purchaseOrderId),
    index("grn_master_vendor_idx").on(t.vendorId),
    index("grn_master_location_idx").on(t.locationId),
  ],
);

/** GRN_ITEMS — grn_id is an in-schema FK. */
export const grnItems = inventory.table(
  "grn_items",
  {
    grnItemId: dictPk("grn_item_id"),
    grnId: uuid("grn_id").references(() => grnMaster.grnId),
    purchaseOrderItemId: uuid("purchase_order_item_id"),
    materialId: uuid("material_id"),
    receivedQty: numeric("received_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    acceptedQty: numeric("accepted_qty", { precision: 18, scale: 4 }),
    rejectedQty: numeric("rejected_qty", { precision: 18, scale: 4 }),
    // Step 18 — quantity verification: ordered snapshot (from the PO line) + damaged qty + the
    // computed variance and its classification (MATCHED / SHORT / EXCESS / DAMAGED) + reason.
    orderedQty: numeric("ordered_qty", { precision: 18, scale: 3 }),
    damagedQty: numeric("damaged_qty", { precision: 18, scale: 3 }),
    varianceQty: numeric("variance_qty", { precision: 18, scale: 3 }),
    varianceType: text("variance_type"),
    varianceReason: text("variance_reason"),
    ...metaColumns(),
  },
  (t) => [
    index("grn_items_grn_idx").on(t.grnId),
    index("grn_items_po_item_idx").on(t.purchaseOrderItemId),
    index("grn_items_material_idx").on(t.materialId),
    index("grn_items_uom_idx").on(t.uomId),
  ],
);

/** GRN_CONTAINER — grn_id + grn_item_id are in-schema FKs. */
export const grnContainer = inventory.table(
  "grn_container",
  {
    grnContainerId: dictPk("grn_container_id"),
    grnId: uuid("grn_id").references(() => grnMaster.grnId),
    grnItemId: uuid("grn_item_id").references(() => grnItems.grnItemId),
    containerCode: varchar("container_code", { length: 50 }),
    containerQty: numeric("container_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("grn_container_code_uq").on(t.containerCode),
    index("grn_container_grn_idx").on(t.grnId),
    index("grn_container_grn_item_idx").on(t.grnItemId),
    index("grn_container_uom_idx").on(t.uomId),
  ],
);
