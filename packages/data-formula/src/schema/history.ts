/**
 * Formula change/audit/lineage tables (Phase-1A Data Dictionary, schema `formula`):
 * FORMULA_CHANGE_LOG, FORMULA_COPY_REQUEST, FORMULA_DOCUMENT_MAPPING, FORMULA_EVENT_HIST.
 *
 * In-schema FKs (all → formula_master except copy_request, which is all-soft):
 * formula_change_log.formula_id, formula_document_mapping.formula_id,
 * formula_event_hist.formula_id → formula_master.
 * Every *_version_id, *_by, document/role/material ref is a soft ref (plain uuid, no FK):
 * the version refs point at formula_version but the dict marks them soft, and copy_request's
 * source/target formula refs are soft → masterdata-style lineage, not enforced FKs.
 */
import { index, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { formula } from "./_schema.js";
import { formulaMaster } from "./master.js";

/** FORMULA_CHANGE_LOG — formula_id is an in-schema FK; version/changed_by are soft. */
export const formulaChangeLog = formula.table(
  "formula_change_log",
  {
    formulaChangeLogId: dictPk("formula_change_log_id"),
    formulaId: uuid("formula_id").references(() => formulaMaster.formulaId),
    formulaVersionId: uuid("formula_version_id"),
    fieldName: varchar("field_name", { length: 200 }),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changeReason: text("change_reason"),
    changedBy: uuid("changed_by"),
    changedDt: timestamp("changed_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    index("formula_change_log_formula_idx").on(t.formulaId),
    index("formula_change_log_version_idx").on(t.formulaVersionId),
  ],
);

/** FORMULA_COPY_REQUEST — all refs are soft (lineage). status PENDING/APPROVED/REJECTED/COMPLETED. */
export const formulaCopyRequest = formula.table(
  "formula_copy_request",
  {
    formulaCopyRequestId: dictPk("formula_copy_request_id"),
    sourceFormulaId: uuid("source_formula_id"),
    sourceVersionId: uuid("source_version_id"),
    targetFormulaId: uuid("target_formula_id"),
    requestedBy: uuid("requested_by"),
    requestedDt: timestamp("requested_dt", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    approvedDt: timestamp("approved_dt", { withTimezone: true }),
    copyNotes: text("copy_notes"),
    ...metaColumns(),
  },
  (t) => [
    index("formula_copy_request_source_idx").on(t.sourceFormulaId),
    index("formula_copy_request_target_idx").on(t.targetFormulaId),
  ],
);

/** FORMULA_DOCUMENT_MAPPING — formula_id is an in-schema FK; version/document refs are soft. */
export const formulaDocumentMapping = formula.table(
  "formula_document_mapping",
  {
    formulaDocumentMappingId: dictPk("formula_document_mapping_id"),
    formulaId: uuid("formula_id").references(() => formulaMaster.formulaId),
    formulaVersionId: uuid("formula_version_id"),
    documentTypeId: uuid("document_type_id"),
    documentId: uuid("document_id"),
    ...metaColumns(),
  },
  (t) => [
    index("formula_document_mapping_formula_idx").on(t.formulaId),
    index("formula_document_mapping_version_idx").on(t.formulaVersionId),
  ],
);

/** FORMULA_EVENT_HIST — formula_id is an in-schema FK; version/performed_by are soft. */
export const formulaEventHist = formula.table(
  "formula_event_hist",
  {
    formulaEventHistId: dictPk("formula_event_hist_id"),
    formulaId: uuid("formula_id").references(() => formulaMaster.formulaId),
    formulaVersionId: uuid("formula_version_id"),
    eventType: varchar("event_type", { length: 50 }),
    eventDt: timestamp("event_dt", { withTimezone: true }),
    performedBy: uuid("performed_by"),
    remarks: text("remarks"),
    ...metaColumns(),
  },
  (t) => [
    index("formula_event_hist_formula_idx").on(t.formulaId),
    index("formula_event_hist_version_idx").on(t.formulaVersionId),
  ],
);
