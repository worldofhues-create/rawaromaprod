/**
 * Material picking + issue tables (Phase-1A Data Dictionary): MATERIAL_PICK_LIST,
 * MATERIAL_PICK_LIST_ITEMS, MATERIAL_ISSUE, MATERIAL_ISSUE_ITEM. Direct header->line refs
 * (pick_list_items->pick_list, issue_item->issue) are in-schema FKs; refs to production_order /
 * material_pick_list and material/inventory/uom/user refs are id-only soft refs per the locked
 * dictionary. Note: IssuedQty on material_issue_item is BOOLEAN per the locked dictionary.
 */
import {
  boolean,
  date,
  index,
  numeric,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { production } from "./_schema.js";

/** MATERIAL_PICK_LIST */
export const materialPickList = production.table(
  "material_pick_list",
  {
    materialPickListId: dictPk("material_pick_list_id"),
    productionOrderId: uuid("production_order_id"), // soft ref → production_order (per locked dictionary)
    pickListDate: date("pick_list_date"),
    generatedBy: uuid("generated_by"), // soft ref → iam.user_master
    ...metaColumns(),
  },
  (t) => [index("material_pick_list_order_idx").on(t.productionOrderId)],
);

/** MATERIAL_PICK_LIST_ITEMS */
export const materialPickListItems = production.table(
  "material_pick_list_items",
  {
    materialPickListItemId: dictPk("material_pick_list_item_id"),
    materialPickListId: uuid("material_pick_list_id").references(
      () => materialPickList.materialPickListId,
    ),
    materialId: uuid("material_id"), // soft ref → masterdata.material
    inventoryBatchId: uuid("inventory_batch_id"), // soft ref → inventory.inventory_batch
    pickedQty: numeric("picked_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [
    index("material_pick_list_items_list_idx").on(t.materialPickListId),
    index("material_pick_list_items_material_idx").on(t.materialId),
  ],
);

/** MATERIAL_ISSUE */
export const materialIssue = production.table(
  "material_issue",
  {
    materialIssueId: dictPk("material_issue_id"),
    productionOrderId: uuid("production_order_id"), // soft ref → production_order (per locked dictionary)
    materialPickListId: uuid("material_pick_list_id"), // soft ref → material_pick_list (per locked dictionary)
    issuedDt: timestamp("issued_dt", { withTimezone: true }),
    issuedBy: uuid("issued_by"), // soft ref → iam.user_master
    ...metaColumns(),
  },
  (t) => [
    index("material_issue_order_idx").on(t.productionOrderId),
    index("material_issue_pick_list_idx").on(t.materialPickListId),
  ],
);

/** MATERIAL_ISSUE_ITEM — IssuedQty is BOOLEAN per the locked dictionary. */
export const materialIssueItem = production.table(
  "material_issue_item",
  {
    materialIssueItemId: dictPk("material_issue_item_id"),
    materialIssueId: uuid("material_issue_id").references(
      () => materialIssue.materialIssueId,
    ),
    materialId: uuid("material_id"), // soft ref → masterdata.material
    inventoryBatchId: uuid("inventory_batch_id"), // soft ref → inventory.inventory_batch
    issuedQty: boolean("issued_qty"),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [index("material_issue_item_issue_idx").on(t.materialIssueId)],
);
