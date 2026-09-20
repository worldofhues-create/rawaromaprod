/**
 * QC inspections + their child rows (Phase-1A Data Dictionary, schema `quality`):
 * QC_INSPECTIONS, QC_RESULT_DETAILS, QC_ATTACHMENTS, QC_DISPOSITION.
 *
 * In-schema FKs (real .references): qc_result_details / qc_attachments / qc_disposition
 * → qc_inspections. qc_parameter_id is a soft ref to qc_parameter_master (dict-soft, plain
 * uuid). rm_batch_id, role_id, user_id, document_id are cross-schema SOFT refs — plain uuid.
 * qc_disposition is TABLE-ONLY for schema completeness (CAPA workflow = Phase-1B).
 */
import { index, numeric, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { quality } from "./_schema.js";

/** QC_INSPECTIONS — rm_batch/role/user/inspection_dt; all refs are cross-schema soft. */
export const qcInspections = quality.table(
  "qc_inspections",
  {
    qcInspectionId: dictPk("qc_inspection_id"),
    rmBatchId: uuid("rm_batch_id"),
    inspectionRoleId: uuid("inspection_role_id"),
    inspectorUserId: uuid("inspector_user_id"),
    inspectionDt: timestamp("inspection_dt", { withTimezone: true }),
    overallResult: varchar("overall_result", { length: 255 }),
    ...metaColumns(),
  },
  (t) => [
    index("qc_inspections_rm_batch_idx").on(t.rmBatchId),
    index("qc_inspections_role_idx").on(t.inspectionRoleId),
    index("qc_inspections_inspector_idx").on(t.inspectorUserId),
  ],
);

/** QC_RESULT_DETAILS — qc_inspection_id FK→qc_inspections; qc_parameter_id soft. */
export const qcResultDetails = quality.table(
  "qc_result_details",
  {
    qcResultDetailId: dictPk("qc_result_detail_id"),
    qcInspectionId: uuid("qc_inspection_id").references(() => qcInspections.qcInspectionId),
    qcParameterId: uuid("qc_parameter_id"),
    observedValue: numeric("observed_value", { precision: 18, scale: 4 }),
    observedText: text("observed_text"),
    result: varchar("result", { length: 255 }),
    ...metaColumns(),
  },
  (t) => [
    index("qc_result_details_inspection_idx").on(t.qcInspectionId),
    index("qc_result_details_parameter_idx").on(t.qcParameterId),
  ],
);

/** QC_ATTACHMENTS — qc_inspection_id FK→qc_inspections; document_id soft→platform. */
export const qcAttachments = quality.table(
  "qc_attachments",
  {
    qcAttachmentId: dictPk("qc_attachment_id"),
    qcInspectionId: uuid("qc_inspection_id").references(() => qcInspections.qcInspectionId),
    documentId: uuid("document_id"),
    ...metaColumns(),
  },
  (t) => [
    index("qc_attachments_inspection_idx").on(t.qcInspectionId),
    index("qc_attachments_document_idx").on(t.documentId),
  ],
);

/** QC_DISPOSITION — qc_inspection_id FK→qc_inspections; disposed_by soft. Table only. */
export const qcDisposition = quality.table(
  "qc_disposition",
  {
    qcDispositionId: dictPk("qc_disposition_id"),
    qcInspectionId: uuid("qc_inspection_id").references(() => qcInspections.qcInspectionId),
    dispositionCode: varchar("disposition_code", { length: 50 }),
    dispositionReason: text("disposition_reason"),
    conditions: text("conditions"),
    disposedBy: uuid("disposed_by"),
    disposedDt: timestamp("disposed_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    // one disposition per inspection (NOT a global unique on the ACCEPT/REJECT/REWORK code,
    // which would let only three dispositions ever exist — that was a bug causing 500s).
    index("qc_disposition_inspection_idx").on(t.qcInspectionId),
  ],
);
