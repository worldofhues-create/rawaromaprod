/**
 * sales cluster events — the cross-cluster signals this cluster emits via the transactional
 * outbox. Declared inline with `defineEvent` (no shared contracts package for the @ra clusters
 * yet). Payloads carry ids / soft-refs only.
 *
 * Emitted from the sales order + dispatch flows:
 *   - createSalesOrder  → `sales.order.created`
 *   - confirmSalesOrder → `sales.order.confirmed`
 *   - createDispatch    → `sales.dispatch.created`
 * Downstream (inventory / fulfilment) reacts to reserve / ship finished goods.
 */
import { z } from 'zod';
import { defineEvent, uuid } from '@core/contracts';

export const salesEvents = {
  orderCreated: defineEvent(
    'sales.order.created',
    z.object({ salesOrderId: uuid, customerId: uuid }),
  ),
  orderConfirmed: defineEvent(
    'sales.order.confirmed',
    z.object({ salesOrderId: uuid }),
  ),
  dispatchCreated: defineEvent(
    'sales.dispatch.created',
    z.object({ dispatchId: uuid, salesOrderId: uuid }),
  ),
  // G1/PB-08 — internal (sales.outbox) record of a break-glass manual-continuity action,
  // alongside (not instead of) the ALEMBIC-bound bridge.outbox event emitBridgeManualEvent
  // writes in the same transaction. Kept distinct from orderCreated/orderConfirmed above (which
  // fire for every order, bridge-originated or not) so an ordinary downstream consumer of THIS
  // cluster's outbox can tell a manual-continuity action apart without inspecting `origin`.
  manualContinuity: defineEvent(
    'sales.order.manual_continuity',
    z.object({ salesOrderId: uuid, action: z.enum(['created', 'confirmed', 'item_added']), reason: z.string() }),
  ),
} as const;
