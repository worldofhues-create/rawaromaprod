/**
 * procurement cluster — outbox event descriptors (cross-cluster signals).
 *
 * Declared inline with `defineEvent("<schema>.<entity>.<verb>", …)`. Payloads carry
 * id/soft-ref values only (never row bodies) so consumers cold-read through public-api.
 * The only Phase-1A cross-cluster signal is the issued purchase order (downstream
 * inventory/GRN listens for it).
 */
import { z } from 'zod';
import { defineEvent, uuid } from '@core/contracts';

/** `procurement.po.issued` — a purchase order moved to ISSUED and is now binding. */
export const poIssued = defineEvent(
  'procurement.po.issued',
  z.object({
    purchaseOrderId: uuid,
    vendorId: uuid,
  }),
);

/** `procurement.po.amended` (G2/V4 §113) — a new DRAFT revision was created off a purchase
 *  order that had moved beyond DRAFT; the original is frozen (status AMENDED) and the new
 *  revision needs re-approval per the existing thresholds before it can be issued. */
export const poAmended = defineEvent(
  'procurement.po.amended',
  z.object({
    purchaseOrderId: uuid,
    replacesPurchaseOrderId: uuid,
    vendorId: uuid.nullable(),
  }),
);

/** `procurement.po.cancelled` (G2/V4 §113) — vendor notification signal: downstream/vendor-
 *  facing consumers react to this to tell the vendor the order is off. Also the durable audit
 *  record of the cancellation reason (payload carries it; the row itself carries a copy too). */
export const poCancelled = defineEvent(
  'procurement.po.cancelled',
  z.object({
    purchaseOrderId: uuid,
    vendorId: uuid.nullable(),
    reason: z.string(),
    cancelledBy: uuid,
  }),
);

/** All procurement event descriptors, grouped for ergonomic import. */
export const procurementEvents = {
  poIssued,
  poAmended,
  poCancelled,
} as const;
