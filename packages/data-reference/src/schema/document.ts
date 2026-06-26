/**
 * Document reference masters (Phase-1A Data Dictionary): DOCUMENT_TYPE_MASTER,
 * DOCUMENT_MASTER. DOCUMENT_MASTER.document_type_id is an in-schema FK to
 * DOCUMENT_TYPE_MASTER.
 */
import { index, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

/** DOCUMENT_TYPE_MASTER */
export const documentTypeMaster = platform.table(
  "document_type_master",
  {
    documentTypeId: dictPk("document_type_id"),
    documentTypeCode: varchar("document_type_code", { length: 50 }),
    documentTypeName: varchar("document_type_name", { length: 200 }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("document_type_master_code_uq").on(t.documentTypeCode)],
);

/** DOCUMENT_MASTER — document_type_id is an in-schema FK to DOCUMENT_TYPE_MASTER. */
export const documentMaster = platform.table(
  "document_master",
  {
    documentId: dictPk("document_id"),
    documentTypeId: uuid("document_type_id").references(
      () => documentTypeMaster.documentTypeId,
    ),
    fileName: varchar("file_name", { length: 200 }),
    filePath: varchar("file_path", { length: 255 }),
    uploadedDt: timestamp("uploaded_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [index("document_master_type_idx").on(t.documentTypeId)],
);
