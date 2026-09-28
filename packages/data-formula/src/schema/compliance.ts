/**
 * Vault compliance data + calculated certificates (owner ruling 2026-09-28, item 2; migration
 * scripts/migrations/2026-09-28-vault-compliance.sql, @target: formula). Lives in the Vault
 * database because the calculation needs the decrypted formula, which never leaves the Vault.
 *
 *   rm_compliance_profile     per raw material: is its allergen data complete? its IFRA data?
 *                             (a completed profile with no rows is an explicit "nothing to
 *                             declare"; NO profile is "not entered yet" and blocks a certificate)
 *   rm_allergen_composition   per raw material × regulated allergen (CAS): % present from natural
 *                             and from synthetic sources
 *   rm_ifra_restriction       per raw material × IFRA category: restriction type and max % in
 *                             the finished product, for a named IFRA amendment
 *   compliance_allergen_ref   the regulated allergen list certificates report against (name, CAS)
 *   compliance_setting        reporting threshold, IFRA amendment in force, allergen list reference
 *   compliance_certificate    one calculated certificate (numbers only) per formula version × kind,
 *                             append-only; `seq` is the cursor the main box pulls on
 *   compliance_calc_status    the latest outcome per formula × kind (certified / missing data /
 *                             not configured) with a COUNT of materials lacking data — never the
 *                             list itself, which would be plaintext formula composition at rest
 *
 * material_id is the MAIN box's masterdata.material id (soft ref, as in the sealed ingredient
 * payload). CHECK constraints (percent ranges, restriction types, kinds) are added by the
 * migration's guarded ALTERs. Entered/imported by the regulatory team only — nothing here is seeded with values
 * except the regulated allergen NAME/CAS list (see the migration for its provenance).
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { formula } from "./_schema.js";

export const rmComplianceProfile = formula.table(
  "rm_compliance_profile",
  {
    rmComplianceProfileId: dictPk("rm_compliance_profile_id"),
    materialId: uuid("material_id").notNull(),
    allergenComplete: boolean("allergen_complete").notNull().default(false),
    ifraComplete: boolean("ifra_complete").notNull().default(false),
    /** The IFRA amendment the ifra_complete declaration was made against. */
    ifraAmendment: varchar("ifra_amendment", { length: 20 }),
    sourceRef: text("source_ref"),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("rm_compliance_profile_material_uq").on(t.materialId)],
);

export const rmAllergenComposition = formula.table(
  "rm_allergen_composition",
  {
    rmAllergenCompositionId: dictPk("rm_allergen_composition_id"),
    materialId: uuid("material_id").notNull(),
    cas: varchar("cas", { length: 20 }).notNull(),
    naturalPct: numeric("natural_pct", { precision: 9, scale: 6 }).notNull().default("0"),
    syntheticPct: numeric("synthetic_pct", { precision: 9, scale: 6 }).notNull().default("0"),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("rm_allergen_composition_material_cas_uq").on(t.materialId, t.cas),
    index("rm_allergen_composition_cas_idx").on(t.cas),
  ],
);

export const rmIfraRestriction = formula.table(
  "rm_ifra_restriction",
  {
    rmIfraRestrictionId: dictPk("rm_ifra_restriction_id"),
    materialId: uuid("material_id").notNull(),
    amendment: varchar("amendment", { length: 20 }).notNull(),
    category: varchar("category", { length: 4 }).notNull(),
    restrictionType: varchar("restriction_type", { length: 20 }).notNull(),
    maxPct: numeric("max_pct", { precision: 9, scale: 6 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("rm_ifra_restriction_material_category_uq").on(t.materialId, t.category)],
);

export const complianceAllergenRef = formula.table(
  "compliance_allergen_ref",
  {
    complianceAllergenRefId: dictPk("compliance_allergen_ref_id"),
    cas: varchar("cas", { length: 20 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("compliance_allergen_ref_cas_uq").on(t.cas)],
);

export const complianceSetting = formula.table("compliance_setting", {
  settingKey: varchar("setting_key", { length: 60 }).primaryKey(),
  settingValue: text("setting_value"),
  updatedDt: timestamp("updated_dt", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar("updated_by", { length: 255 }),
});

export const complianceCertificate = formula.table(
  "compliance_certificate",
  {
    certificateId: dictPk("certificate_id"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    formulaId: uuid("formula_id").notNull(),
    formulaVersionId: uuid("formula_version_id").notNull(),
    formulaVersionRef: varchar("formula_version_ref", { length: 80 }).notNull(),
    kind: varchar("kind", { length: 10 }).notNull(),
    amendment: varchar("amendment", { length: 60 }),
    certValues: jsonb("cert_values").notNull(),
    valuesDigest: varchar("values_digest", { length: 64 }).notNull(),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
    calcTrigger: varchar("calc_trigger", { length: 40 }),
    createdBy: varchar("created_by", { length: 255 }),
  },
  (t) => [
    uniqueIndex("compliance_certificate_seq_uq").on(t.seq),
    index("compliance_certificate_formula_kind_idx").on(t.formulaId, t.kind),
  ],
);

export const complianceCalcStatus = formula.table(
  "compliance_calc_status",
  {
    formulaId: uuid("formula_id").notNull(),
    kind: varchar("kind", { length: 10 }).notNull(),
    formulaVersionId: uuid("formula_version_id"),
    outcome: varchar("outcome", { length: 20 }).notNull(),
    missingCount: integer("missing_count").notNull().default(0),
    lastCertificateId: uuid("last_certificate_id"),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.formulaId, t.kind] })],
);
