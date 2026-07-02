/**
 * quality cluster DTOs — zod create bodies (one per quality table) + the QC flow action
 * bodies (add results, dispose) + the generic cursor list query. Bodies carry only the Data
 * Dictionary columns; the service fills the meta tail (status / document state, created_by /
 * updated_by from the principal). Numerics arrive as numbers and are stringified at insert;
 * timestamps as ISO strings; cross-schema / dict-soft refs are plain uuids.
 */
import { z } from 'zod';

/** Generic cursor list query shared by every table. */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/* ── qc parameter catalog ─────────────────────────────────────────────── */

export const createQcParameter = z.object({
  parameterCode: z.string(),
  parameterName: z.string(),
  uomId: z.string().uuid().optional(),
});
export type CreateQcParameter = z.infer<typeof createQcParameter>;

/* ── qc inspections ───────────────────────────────────────────────────── */

export const createQcInspection = z.object({
  rmBatchId: z.string().uuid(),
  inspectionRoleId: z.string().uuid().optional(),
  inspectorUserId: z.string().uuid().optional(),
  inspectionDt: z.string().datetime().optional(),
});
export type CreateQcInspection = z.infer<typeof createQcInspection>;

/* ── qc result details ────────────────────────────────────────────────── */

export const createQcResultDetail = z.object({
  qcParameterId: z.string().uuid().optional(),
  observedValue: z.number().optional(),
  result: z.string().optional(),
});
export type CreateQcResultDetail = z.infer<typeof createQcResultDetail>;

/** Flow body for POST /v1/qc-inspections/:id/results — one or more result rows. */
export const addResults = z.object({
  results: z.array(createQcResultDetail).min(1),
});
export type AddResults = z.infer<typeof addResults>;

/* ── qc attachments ───────────────────────────────────────────────────── */

export const createQcAttachment = z.object({
  qcInspectionId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
});
export type CreateQcAttachment = z.infer<typeof createQcAttachment>;

/* ── qc disposition (flow body) ───────────────────────────────────────── */

export const disposeInspection = z.object({
  dispositionCode: z.enum(['ACCEPT', 'REJECT', 'REWORK', 'HOLD']),
  dispositionReason: z.string().optional(),
  conditions: z.string().optional(),
  disposedBy: z.string().uuid().optional(),
  disposedDt: z.string().datetime().optional(),
});
export type DisposeInspection = z.infer<typeof disposeInspection>;

/* ── qc sample retention ──────────────────────────────────────────────── */

export const createQcSampleRetention = z.object({
  qcInspectionId: z.string().uuid().optional(),
  rmBatchId: z.string().uuid().optional(),
  oilBatchId: z.string().uuid().optional(),
  sampleCode: z.string(),
  sampleQty: z.number().optional(),
  uomId: z.string().uuid().optional(),
  retentionLocationId: z.string().uuid().optional(),
  retainedDt: z.string().datetime().optional(),
  retainedBy: z.string().uuid().optional(),
  retentionExpiryDt: z.string().datetime().optional(),
});
export type CreateQcSampleRetention = z.infer<typeof createQcSampleRetention>;

/* ── qc capa (table-only CRUD) ────────────────────────────────────────── */

export const createQcCapa = z.object({
  qcInspectionId: z.string().uuid().optional(),
  capaCode: z.string(),
  capaType: z.string().optional(),
  description: z.string().optional(),
  rootCause: z.string().optional(),
  actionPlan: z.string().optional(),
  assignedTo: z.string().uuid().optional(),
  dueDt: z.string().datetime().optional(),
  closedDt: z.string().datetime().optional(),
  closureEvidence: z.string().optional(),
  verifiedBy: z.string().uuid().optional(),
  verifiedDt: z.string().datetime().optional(),
});
export type CreateQcCapa = z.infer<typeof createQcCapa>;
