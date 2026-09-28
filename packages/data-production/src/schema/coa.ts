/**
 * Certificate-of-Analysis data from factory QC (owner ruling 2026-09-28, item 1; migration
 * scripts/migrations/2026-09-28-compliance-documents.sql). Three tables:
 *
 *   PRODUCT_QC_SPEC   per product (packaging.product_master, soft ref): specific gravity at 20/4 °C
 *                     min/max, flash point (Pensky-Martens closed cup) min/max °C, shelf life in
 *                     months, and optional colour/odour standards the QC analyst compares against.
 *   BATCH_COA         one per oil batch (the finished fragrance batch a COA is issued for): each
 *                     result with the spec snapshot it was judged against, pass/fail per test and
 *                     overall, production date and best-before (production date + shelf life), and
 *                     the release. Only a RELEASED (overall PASS) row is ever emitted to ALEMBIC.
 *   BATCH_COA_PHOTO   the batch photos: a platform.document_master reference (RawProd's asset
 *                     record) and/or an http(s) URL, with a caption.
 *
 * oil_batch / product / document / user refs are id-only soft refs (cross-schema, per the
 * dictionary's convention); batch_coa_photo → batch_coa is an in-schema FK. The CHECKs (spec
 * ranges, TESTED/RELEASED state, photo needs a reference) are in the migration.
 */
import { boolean, date, index, integer, numeric, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { production } from "./_schema.js";

export const productQcSpec = production.table(
  "product_qc_spec",
  {
    productQcSpecId: dictPk("product_qc_spec_id"),
    productId: uuid("product_id").notNull(), // soft ref → packaging.product_master
    sgMin: numeric("sg_min", { precision: 8, scale: 4 }).notNull(),
    sgMax: numeric("sg_max", { precision: 8, scale: 4 }).notNull(),
    flashPointMinC: numeric("flash_point_min_c", { precision: 6, scale: 1 }).notNull(),
    flashPointMaxC: numeric("flash_point_max_c", { precision: 6, scale: 1 }).notNull(),
    shelfLifeMonths: integer("shelf_life_months").notNull(),
    colourAppearanceStandard: text("colour_appearance_standard"),
    odourStandard: text("odour_standard"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("product_qc_spec_product_uq").on(t.productId)],
);

export const batchCoa = production.table(
  "batch_coa",
  {
    batchCoaId: dictPk("batch_coa_id"),
    oilBatchId: uuid("oil_batch_id").notNull(), // soft ref → oil_batch_master
    productId: uuid("product_id").notNull(), // soft ref → packaging.product_master
    sgResult: numeric("sg_result", { precision: 8, scale: 4 }).notNull(),
    sgSpecMin: numeric("sg_spec_min", { precision: 8, scale: 4 }).notNull(),
    sgSpecMax: numeric("sg_spec_max", { precision: 8, scale: 4 }).notNull(),
    sgPass: boolean("sg_pass").notNull(),
    flashPointResultC: numeric("flash_point_result_c", { precision: 6, scale: 1 }).notNull(),
    flashPointSpecMinC: numeric("flash_point_spec_min_c", { precision: 6, scale: 1 }).notNull(),
    flashPointSpecMaxC: numeric("flash_point_spec_max_c", { precision: 6, scale: 1 }).notNull(),
    flashPointPass: boolean("flash_point_pass").notNull(),
    colourAppearance: text("colour_appearance").notNull(),
    colourAppearancePass: boolean("colour_appearance_pass").notNull(),
    odourDescription: text("odour_description").notNull(),
    odourPass: boolean("odour_pass").notNull(),
    productionDate: date("production_date").notNull(),
    bestBefore: date("best_before").notNull(),
    overallResult: varchar("overall_result", { length: 10 }).notNull(),
    testedBy: uuid("tested_by"), // soft ref → iam.user_master
    testedDt: timestamp("tested_dt", { withTimezone: true }).notNull().defaultNow(),
    releasedBy: uuid("released_by"), // soft ref → iam.user_master
    releasedDt: timestamp("released_dt", { withTimezone: true }),
    // Lane produce: QC's FAIL verdict (status REJECTED). A rejected batch is never labelled; a
    // re-test that passes can still be released later (ALEMBIC takes the latest verdict).
    rejectedBy: uuid("rejected_by"), // soft ref → iam.user_master
    rejectedDt: timestamp("rejected_dt", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("batch_coa_oil_batch_uq").on(t.oilBatchId),
    index("batch_coa_product_idx").on(t.productId),
  ],
);

export const batchCoaPhoto = production.table(
  "batch_coa_photo",
  {
    batchCoaPhotoId: dictPk("batch_coa_photo_id"),
    batchCoaId: uuid("batch_coa_id").notNull().references(() => batchCoa.batchCoaId),
    documentId: uuid("document_id"), // soft ref → platform.document_master
    url: text("url"),
    caption: varchar("caption", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [index("batch_coa_photo_coa_idx").on(t.batchCoaId)],
);
