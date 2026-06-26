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
} as const;
