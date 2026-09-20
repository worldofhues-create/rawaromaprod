/**
 * Production planning tables (Phase-1A Data Dictionary): PRODUCTION_PLAN, PRODUCTION_PLAN_ITEMS,
 * PRODUCTION_ORDER, PRODUCTION_ORDER_INGREDIENTS. Direct header->line refs (plan_items->plan,
 * order_ingredients->order) are in-schema FKs; order->plan_items and all formula/location/uom refs
 * are id-only soft refs per the locked dictionary (no cross-schema FK). Note: IssuedQty
 * on production_order_ingredients is BOOLEAN per the locked dictionary.
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

/** PRODUCTION_PLAN */
export const productionPlan = production.table(
  "production_plan",
  {
    productionPlanId: dictPk("production_plan_id"),
    locationId: uuid("location_id"), // soft ref → location
    planDate: date("plan_date"),
    plannedStartDt: timestamp("planned_start_dt", { withTimezone: true }),
    plannedEndDt: timestamp("planned_end_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("production_plan_location_idx").on(t.locationId)],
);

/** PRODUCTION_PLAN_ITEMS */
export const productionPlanItems = production.table(
  "production_plan_items",
  {
    productionPlanItemId: dictPk("production_plan_item_id"),
    productionPlanId: uuid("production_plan_id").references(
      () => productionPlan.productionPlanId,
    ),
    formulaId: uuid("formula_id"), // soft ref → formula.formula_master
    plannedQty: numeric("planned_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [
    index("production_plan_items_plan_idx").on(t.productionPlanId),
    index("production_plan_items_formula_idx").on(t.formulaId),
  ],
);

/** PRODUCTION_ORDER */
export const productionOrder = production.table(
  "production_order",
  {
    productionOrderId: dictPk("production_order_id"),
    productionPlanItemId: uuid("production_plan_item_id"), // soft ref → production_plan_items (per locked dictionary)
    formulaVersionId: uuid("formula_version_id"), // soft ref → formula.formula_version
    locationId: uuid("location_id"), // soft ref → location
    orderQty: numeric("order_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    actualStartDt: timestamp("actual_start_dt", { withTimezone: true }),
    actualEndDt: timestamp("actual_end_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("production_order_plan_item_idx").on(t.productionPlanItemId),
    index("production_order_location_idx").on(t.locationId),
  ],
);

/** PRODUCTION_ORDER_INGREDIENTS — IssuedQty is BOOLEAN per the locked dictionary. */
export const productionOrderIngredients = production.table(
  "production_order_ingredients",
  {
    productionOrderIngredientId: dictPk("production_order_ingredient_id"),
    productionOrderId: uuid("production_order_id").references(
      () => productionOrder.productionOrderId,
    ),
    materialId: uuid("material_id"), // soft ref → masterdata.material
    requiredQty: numeric("required_qty", { precision: 18, scale: 4 }),
    issuedQty: boolean("issued_qty"),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    ...metaColumns(),
  },
  (t) => [index("production_order_ingredients_order_idx").on(t.productionOrderId)],
);
