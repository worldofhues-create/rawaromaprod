/**
 * production cluster DTOs — zod bodies for the planning masters + the flow actions (generate
 * pick list, issue materials, mixing session/steps, produce oil batch, record QC) + the generic
 * cursor list query. Numerics arrive as numbers and are stringified at insert; timestamps as ISO
 * strings; cross-schema refs are plain uuids. production_order_ingredients are NOT created
 * directly — they are expanded server-side from the approved formula's pick list.
 */
import { z } from 'zod';

/** Generic cursor list query shared by every table. */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/* ── production plan ───────────────────────────────────────────────────── */

export const createPlan = z.object({
  locationId: z.string().uuid().optional(),
  planDate: z.string().optional(), // ISO date (yyyy-mm-dd)
  plannedStartDt: z.string().datetime().optional(),
  plannedEndDt: z.string().datetime().optional(),
});
export type CreatePlan = z.infer<typeof createPlan>;

export const createPlanItem = z.object({
  productionPlanId: z.string().uuid(),
  formulaId: z.string().uuid().optional(),
  plannedQty: z.number().nonnegative().optional(),
  uomId: z.string().uuid().optional(),
});
export type CreatePlanItem = z.infer<typeof createPlanItem>;

/* ── production order (expands the formula's pick list) ────────────────── */

export const createOrder = z.object({
  productionPlanItemId: z.string().uuid().optional(),
  formulaVersionId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  orderQty: z.number().positive(),
  uomId: z.string().uuid().optional(),
});
export type CreateOrder = z.infer<typeof createOrder>;

/* ── material picking ──────────────────────────────────────────────────── */

export const generatePickList = z.object({
  pickListDate: z.string().optional(), // ISO date
});
export type GeneratePickList = z.infer<typeof generatePickList>;

/* ── material issue ────────────────────────────────────────────────────── */

const issueItem = z.object({
  materialId: z.string().uuid(),
  inventoryBatchId: z.string().uuid().optional(),
  uomId: z.string().uuid().optional(),
});

export const createIssue = z.object({
  productionOrderId: z.string().uuid(),
  materialPickListId: z.string().uuid().optional(),
  issuedDt: z.string().datetime().optional(),
  items: z.array(issueItem).min(1),
});
export type CreateIssue = z.infer<typeof createIssue>;

/* ── secure mixing ─────────────────────────────────────────────────────── */

export const createMixingSession = z.object({
  productionOrderId: z.string().uuid(),
  operatorId: z.string().uuid().optional(),
  sessionStartDt: z.string().datetime().optional(),
});
export type CreateMixingSession = z.infer<typeof createMixingSession>;

export const logStep = z.object({
  formulaStageId: z.string().uuid().optional(),
  stepSequence: z.number().int().optional(),
  stepDescription: z.string().optional(),
  performedBy: z.string().uuid().optional(),
  performedDt: z.string().datetime().optional(),
});
export type LogStep = z.infer<typeof logStep>;

export const endMixingSession = z.object({
  sessionEndDt: z.string().datetime().optional(),
});
export type EndMixingSession = z.infer<typeof endMixingSession>;

/* ── oil batch (master + consumption genealogy) ───────────────────────── */

const consumptionRow = z.object({
  consumedForDocumentId: z.string().uuid().optional(),
  consumedQty: z.number().nonnegative(),
  uomId: z.string().uuid().optional(),
  consumedDt: z.string().datetime().optional(),
});

export const produceOilBatch = z.object({
  productionOrderId: z.string().uuid(),
  secureMixingSessionId: z.string().uuid().optional(),
  batchNumber: z.string(),
  producedQty: z.number().positive(),
  uomId: z.string().uuid().optional(),
  producedDt: z.string().datetime().optional(),
  consumption: z.array(consumptionRow).optional(),
});
export type ProduceOilBatch = z.infer<typeof produceOilBatch>;

/* ── production QC ─────────────────────────────────────────────────────── */

export const recordProductionQc = z.object({
  oilBatchId: z.string().uuid(),
  qcParameterId: z.string().uuid().optional(),
  observedValue: z.number().optional(),
  result: z.string().optional(),
  inspectedBy: z.string().uuid().optional(),
  inspectionDt: z.string().datetime().optional(),
});
export type RecordProductionQc = z.infer<typeof recordProductionQc>;
