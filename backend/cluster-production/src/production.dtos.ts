/**
 * production cluster DTOs — zod bodies for the planning masters + the flow actions (generate
 * pick list, issue materials, mixing session/steps, produce oil batch, record QC) + the generic
 * cursor list query. Numerics arrive as numbers and are stringified at insert; timestamps as ISO
 * strings; cross-schema refs are plain uuids. production_order_ingredients are NOT created
 * directly — they are expanded server-side from the approved formula's pick list.
 */
import { z } from 'zod';

/** Accept a date-only string (yyyy-mm-dd, as the UI date pickers emit) OR a full ISO datetime,
 * normalising a bare date to midnight UTC. Fixes "Validation failed" when a form date field posts
 * 2026-07-03 into a timestamp column. */
const isoDateish = () =>
  z.preprocess(
    (v) => (typeof v === 'string' && v && !v.includes('T') ? `${v}T00:00:00.000Z` : v),
    z.string().datetime().optional(),
  );

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
  plannedStartDt: isoDateish(),
  plannedEndDt: isoDateish(),
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
  // RP-EMIT (lane F6): when this order schedules production against an ALEMBIC-originated
  // requirement RawProd already accepted (bridge.production_requirement), the caller passes
  // that requirement's id so this order can be linked to it and a ProductionScheduled event
  // emitted toward ALEMBIC. Omitted for RawProd's own internal orders — not every order is
  // bridge-originated.
  alembicRequirementId: z.string().uuid().optional(),
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

/** RP-PROD-004: materialPickListId is REQUIRED, not optional. production cannot write the
 * inventory schema (cluster boundary) — the async ConsumptionService (backend/api/src/
 * consumption/consumption.service.ts) is what actually debits inventory_batch.quantity_on_hand,
 * and it can only do that from a pick list line's picked_qty. An issue with no pick list has no
 * quantity anywhere for the consumer to apply, so it is silently never debited — while
 * MixingService.abortSession used to still credit it back on abort, minting phantom stock. */
export const createIssue = z.object({
  productionOrderId: z.string().uuid(),
  materialPickListId: z.string().uuid(),
  issuedDt: isoDateish(),
  items: z.array(issueItem).min(1),
});
export type CreateIssue = z.infer<typeof createIssue>;

/* ── secure mixing ─────────────────────────────────────────────────────── */

export const createMixingSession = z.object({
  productionOrderId: z.string().uuid(),
  operatorId: z.string().uuid().optional(),
  sessionStartDt: isoDateish(),
});
export type CreateMixingSession = z.infer<typeof createMixingSession>;

export const logStep = z.object({
  formulaStageId: z.string().uuid().optional(),
  stepSequence: z.number().int().optional(),
  stepDescription: z.string().optional(),
  performedBy: z.string().uuid().optional(),
  performedDt: isoDateish(),
});
export type LogStep = z.infer<typeof logStep>;

export const endMixingSession = z.object({
  sessionEndDt: isoDateish(),
});
export type EndMixingSession = z.infer<typeof endMixingSession>;

/** RP-FAC2 (RP-PROD-003): abort an IN_PROGRESS mixing session — reason is required so the audit
 * trail (a mixing_step_log row) always explains why the session was killed. */
export const abortMixingSession = z.object({
  reason: z.string().min(1),
  sessionEndDt: isoDateish(),
});
export type AbortMixingSession = z.infer<typeof abortMixingSession>;

/* ── oil batch (master + consumption genealogy) ───────────────────────── */

const consumptionRow = z.object({
  consumedForDocumentId: z.string().uuid().optional(),
  consumedQty: z.number().nonnegative(),
  uomId: z.string().uuid().optional(),
  consumedDt: isoDateish(),
});

export const produceOilBatch = z.object({
  productionOrderId: z.string().uuid(),
  secureMixingSessionId: z.string().uuid().optional(),
  batchNumber: z.string(),
  producedQty: z.number().positive(),
  uomId: z.string().uuid().optional(),
  producedDt: isoDateish(),
  consumption: z.array(consumptionRow).optional(),
});
export type ProduceOilBatch = z.infer<typeof produceOilBatch>;

/* ── production QC ─────────────────────────────────────────────────────── */

export const recordProductionQc = z.object({
  oilBatchId: z.string().uuid(),
  qcParameterId: z.string().uuid().optional(),
  observedValue: z.number().optional(),
  result: z.string().optional(),
  // Spec range (audit #8): when supplied, the observed value is auto-graded PASS/FAIL against
  // [specMin, specMax] instead of relying on a free-text result.
  specMin: z.number().optional(),
  specMax: z.number().optional(),
  inspectedBy: z.string().uuid().optional(),
  inspectionDt: isoDateish(),
});
export type RecordProductionQc = z.infer<typeof recordProductionQc>;

/** POST /v1/oil-batches/:id/transition — a guarded oil-batch lifecycle move (audit H-C6). */
export const transitionOilBatch = z.object({
  status: z.enum(['IN_MATURATION', 'MATURING', 'RELEASED', 'HOLD', 'REWORK', 'FAILED']),
});
export type TransitionOilBatch = z.infer<typeof transitionOilBatch>;
