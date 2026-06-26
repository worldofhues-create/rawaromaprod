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

/** All procurement event descriptors, grouped for ergonomic import. */
export const procurementEvents = {
  poIssued,
} as const;
