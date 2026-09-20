/**
 * inventory cluster event descriptors — declared inline (the data package owns the outbox
 * TABLE; the cluster owns the event CONTRACTS). Cross-cluster signals carry ids/soft-refs
 * only. Recorded via `recordOutbox(tx, inventory.outbox, <descriptor>, payload, aggregateId)`
 * inside the same transaction as the domain write.
 */
import { z } from 'zod';
import { defineEvent, uuid } from '@core/contracts';

export const inventoryEvents = {
  /** A GRN was received (one outbox row per GRN). */
  grnCreated: defineEvent(
    'inventory.grn.created',
    z.object({ grnId: uuid, purchaseOrderId: uuid.nullable() }),
  ),
  /** An RM batch was created from a GRN line (one per batch). */
  batchCreated: defineEvent(
    'inventory.batch.created',
    z.object({ rmBatchId: uuid, materialId: uuid.nullable() }),
  ),
} as const;
