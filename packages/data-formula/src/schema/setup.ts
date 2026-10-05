/**
 * Formula setup (lane vaultsetup, owner decisions 2026-10-05: products are mostly blended
 * in-house; "Ruh drafts, one person approves"). Migration: scripts/migrations/
 * 2026-10-05-formula-setup.sql (@target: formula).
 *
 * FORMULA_PRODUCT_LINK — which factory product a Vault formula SHELL was drafted for, and how the
 * catalogue classified that product. One row per formula and one per product (both unique), so a
 * re-run of the shell step finds the formula it already drafted instead of drafting a second one.
 *
 *   product_id / product_code / product_name  the MAIN box's packaging.product_master row (soft
 *       ref — the Vault has no path to that database). Product identity is Vault-authority data
 *       (formula-directory.service.ts): it is held here and never sent back to the main box.
 *   kind  'single_chemical' (the product IS one material: the shell is sealed at 100 % of
 *       `material_id` and submitted for review) or 'blend' (the shell is left an empty DRAFT —
 *       "recipe needed" — until a formulator seals the recipe).
 *   material_id  the product's own material (masterdata.material on the main box) for a
 *       single_chemical; null for a blend.
 *
 * Nothing here is secret: the recipe itself stays sealed in formula_ingredients.
 */
import { index, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { formula } from "./_schema.js";
import { formulaMaster } from "./master.js";

export const formulaProductLink = formula.table(
  "formula_product_link",
  {
    formulaProductLinkId: dictPk("formula_product_link_id"),
    formulaId: uuid("formula_id")
      .notNull()
      .references(() => formulaMaster.formulaId),
    productId: uuid("product_id").notNull(), // soft ref → packaging.product_master (main box)
    productCode: varchar("product_code", { length: 50 }).notNull(),
    productName: varchar("product_name", { length: 200 }),
    kind: varchar("kind", { length: 20 }).notNull(),
    materialId: uuid("material_id"), // soft ref → masterdata.material (main box)
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("formula_product_link_formula_uq").on(t.formulaId),
    uniqueIndex("formula_product_link_product_uq").on(t.productId),
    index("formula_product_link_code_idx").on(t.productCode),
  ],
);
