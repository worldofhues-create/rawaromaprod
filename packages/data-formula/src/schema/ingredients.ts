/**
 * Formula recipe tables (Phase-1A Data Dictionary, schema `formula`):
 * FORMULA_INGREDIENTS, FORMULA_STAGE_MASTER, FORMULA_STAGE_INGREDIENTS.
 *
 * ENCRYPTION AT REST (owner decision, faithful to the dict's "[ENCRYPTED]" marks):
 * the sensitive pair (material_id + percentage) is NOT stored in plaintext. It is sealed
 * into a single ciphertext { materialId, percentage } stored as enc_payload + enc_iv +
 * enc_tag. The structural columns (formula_version_id / formula_stage_id FK, sequence_no)
 * stay plaintext so the recipe shape is queryable without decrypting.
 *
 * In-schema FKs: formula_ingredients.formula_version_id → formula_version;
 * formula_stage_master.formula_version_id → formula_version;
 * formula_stage_ingredients.formula_stage_id → formula_stage_master.
 */
import { index, integer, text, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { formula } from "./_schema.js";
import { formulaVersion } from "./master.js";

/**
 * FORMULA_INGREDIENTS — material_id + percentage are SEALED into enc_payload/iv/tag.
 * formula_version_id (FK) and sequence_no stay plaintext.
 */
export const formulaIngredients = formula.table(
  "formula_ingredients",
  {
    formulaIngredientsId: dictPk("formula_ingredients_id"),
    formulaVersionId: uuid("formula_version_id").references(() => formulaVersion.formulaVersionId),
    encPayload: text("enc_payload").notNull(),
    encIv: text("enc_iv").notNull(),
    encTag: text("enc_tag").notNull(),
    sequenceNo: integer("sequence_no"),
    ...metaColumns(),
  },
  (t) => [index("formula_ingredients_version_idx").on(t.formulaVersionId)],
);

/** FORMULA_STAGE_MASTER — formula_version_id is an in-schema FK. */
export const formulaStageMaster = formula.table(
  "formula_stage_master",
  {
    formulaStageId: dictPk("formula_stage_id"),
    formulaVersionId: uuid("formula_version_id").references(() => formulaVersion.formulaVersionId),
    stageName: varchar("stage_name", { length: 200 }),
    sequenceNo: integer("sequence_no"),
    stageInstructions: varchar("stage_instructions", { length: 255 }),
    ...metaColumns(),
  },
  (t) => [index("formula_stage_master_version_idx").on(t.formulaVersionId)],
);

/**
 * FORMULA_STAGE_INGREDIENTS — material_id + percentage are SEALED into enc_payload/iv/tag.
 * formula_stage_id (FK) and sequence_no stay plaintext.
 */
export const formulaStageIngredients = formula.table(
  "formula_stage_ingredients",
  {
    formulaStageIngredientsId: dictPk("formula_stage_ingredients_id"),
    formulaStageId: uuid("formula_stage_id").references(() => formulaStageMaster.formulaStageId),
    encPayload: text("enc_payload").notNull(),
    encIv: text("enc_iv").notNull(),
    encTag: text("enc_tag").notNull(),
    sequenceNo: integer("sequence_no"),
    ...metaColumns(),
  },
  (t) => [index("formula_stage_ingredients_stage_idx").on(t.formulaStageId)],
);
