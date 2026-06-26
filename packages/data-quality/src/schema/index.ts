/**
 * quality schema barrel (Phase-1A Data Dictionary) — every table in the quality cluster.
 * drizzle.config.ts points `schema` here.
 *
 * Tables: qc_parameter_master (catalog); qc_inspections, qc_result_details, qc_attachments,
 *   qc_disposition (inspections + disposition); qc_sample_retention, qc_capa (retention +
 *   CAPA table-only); + outbox, audit_events crosscutting.
 */
export { quality } from "./_schema.js";

export { qcParameterMaster } from "./qc-config.js";
export {
  qcInspections,
  qcResultDetails,
  qcAttachments,
  qcDisposition,
} from "./inspections.js";
export { qcSampleRetention, qcCapa } from "./retentions.js";
export { outbox, auditEvents } from "./crosscutting.js";
