/**
 * production cluster events — cross-cluster signals via the transactional outbox. Payloads
 * carry ids + non-secret scalars only (never a material_id list or formula data). The order's
 * bill-of-materials lives inside the production schema; only the fact of progression is emitted.
 *
 * Downstream: packaging subscribes to `production.oil_batch.created` to allow a packaging order
 * against a produced oil batch (23-step flow, step 19).
 */
import { z } from 'zod';
import { defineEvent, uuid } from '@core/contracts';

export const productionEvents = {
  orderCreated: defineEvent(
    'production.order.created',
    z.object({ productionOrderId: uuid, formulaVersionId: uuid, ingredientCount: z.number().int() }),
  ),
  materialsIssued: defineEvent(
    'production.materials.issued',
    z.object({ productionOrderId: uuid, materialIssueId: uuid }),
  ),
  oilBatchCreated: defineEvent(
    'production.oil_batch.created',
    z.object({ oilBatchId: uuid, productionOrderId: uuid, batchNumber: z.string().nullable() }),
  ),
  qcRecorded: defineEvent(
    'production.qc.recorded',
    z.object({ productionQcId: uuid, oilBatchId: uuid, result: z.string().nullable() }),
  ),
} as const;
