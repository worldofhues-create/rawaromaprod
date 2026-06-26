/**
 * QC sample retention + CAPA (Phase-1A Data Dictionary, schema `quality`):
 * QC_SAMPLE_RETENTION, QC_CAPA.
 *
 * Both reference qc_inspections via qc_inspection_id, but the dictionary marks these as
 * SOFT (dict-soft) — so they are plain uuid columns with NO .references(). rm_batch_id,
 * oil_batch_id, uom_id, retention_location_id, retained_by / assigned_to / verified_by are
 * cross-schema soft refs — plain uuid. qc_capa is TABLE-ONLY (CAPA workflow = Phase-1B).
 */
import { index, numeric, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { quality } from "./_schema.js";

/** QC_SAMPLE_RETENTION — qc_inspection_id soft (plain uuid); all other refs soft too. */
export const qcSampleRetention = quality.table(
  "qc_sample_retention",
  {
    qcSampleRetentionId: dictPk("qc_sample_retention_id"),
    qcInspectionId: uuid("qc_inspection_id"),
    rmBatchId: uuid("rm_batch_id"),
    oilBatchId: uuid("oil_batch_id"),
    sampleCode: varchar("sample_code", { length: 50 }),
    sampleQty: numeric("sample_qty", { precision: 18, scale: 4 }),
    uomId: uuid("uom_id"),
    retentionLocationId: uuid("retention_location_id"),
    retainedDt: timestamp("retained_dt", { withTimezone: true }),
    retainedBy: uuid("retained_by"),
    retentionExpiryDt: timestamp("retention_expiry_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("qc_sample_retention_code_uq").on(t.sampleCode),
    index("qc_sample_retention_inspection_idx").on(t.qcInspectionId),
    index("qc_sample_retention_rm_batch_idx").on(t.rmBatchId),
    index("qc_sample_retention_oil_batch_idx").on(t.oilBatchId),
  ],
);

/** QC_CAPA — qc_inspection_id soft (plain uuid); assigned_to / verified_by soft. Table only. */
export const qcCapa = quality.table(
  "qc_capa",
  {
    qcCapaId: dictPk("qc_capa_id"),
    qcInspectionId: uuid("qc_inspection_id"),
    capaCode: varchar("capa_code", { length: 50 }),
    capaType: varchar("capa_type", { length: 30 }),
    description: text("description"),
    rootCause: text("root_cause"),
    actionPlan: text("action_plan"),
    assignedTo: uuid("assigned_to"),
    dueDt: timestamp("due_dt", { withTimezone: true }),
    closedDt: timestamp("closed_dt", { withTimezone: true }),
    closureEvidence: text("closure_evidence"),
    verifiedBy: uuid("verified_by"),
    verifiedDt: timestamp("verified_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("qc_capa_code_uq").on(t.capaCode),
    index("qc_capa_inspection_idx").on(t.qcInspectionId),
  ],
);
