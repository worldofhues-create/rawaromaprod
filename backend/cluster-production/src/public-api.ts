/**
 * production cluster — PUBLIC API. Downstream clusters (packaging, traceability) hold a
 * production_order_id or oil_batch_id as a soft ref and occasionally need a cold read of its
 * state. The only surface exposed is the `ProductionLookup` read port (ids + status/qty only).
 * Inject by `PRODUCTION_LOOKUP`; never sync-import the cluster internals.
 */

export interface OrderRef {
  productionOrderId: string;
  formulaVersionId: string | null;
  orderQty: string | null;
  status: string | null;
}

export interface OilBatchRef {
  oilBatchId: string;
  productionOrderId: string | null;
  batchNumber: string | null;
  producedQty: string | null;
  status: string | null;
}

/** Cold read port into the production masters. */
export interface ProductionLookup {
  getOrder(productionOrderId: string): Promise<OrderRef | null>;
  getOilBatch(oilBatchId: string): Promise<OilBatchRef | null>;
}

/** DI token for `ProductionLookup`. */
export const PRODUCTION_LOOKUP = Symbol('PRODUCTION_LOOKUP');
