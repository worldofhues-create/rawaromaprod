/**
 * packaging cluster events — the cross-cluster signals this cluster emits via the
 * transactional outbox. Declared inline with `defineEvent` (no shared contracts package for
 * the @ra clusters yet). Payloads carry ids / soft-refs + non-secret scalars only.
 *
 *   orderCreated  → on package-order creation (downstream: inventory issue, planning).
 *   fillingDone   → on a recorded filling-session detail (optional signal).
 *   fgBatchCreated→ on finished-good batch production (downstream: sales / dispatch).
 */
import { z } from 'zod';
import { defineEvent, uuid } from '@core/contracts';

export const packagingEvents = {
  orderCreated: defineEvent(
    'packaging.order.created',
    z.object({ packageOrderId: uuid, oilBatchId: uuid }),
  ),
  fillingDone: defineEvent(
    'packaging.filling.done',
    z.object({ fillingSessionId: uuid, fillingSessionDetailId: uuid }),
  ),
  fgBatchCreated: defineEvent(
    'packaging.fg_batch.created',
    z.object({
      finishedGoodBatchId: uuid,
      packageOrderId: uuid,
      batchNumber: z.string(),
    }),
  ),
} as const;
