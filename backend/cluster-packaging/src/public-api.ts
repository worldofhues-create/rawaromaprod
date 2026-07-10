/**
 * packaging cluster — PUBLIC API. Other clusters (sales, dispatch) occasionally need a cold
 * read of a package order or a finished-good batch to gate a sales/dispatch action. The only
 * surface we expose is the `PackagingLookup` read port (ids + key scalars only). Inject by the
 * `PACKAGING_LOOKUP` token; never sync-import the cluster itself.
 */

export interface PackageOrderRef {
  packageOrderId: string;
  productSkuId: string | null;
  oilBatchId: string | null;
  status: string | null;
}

export interface FinishedGoodBatchRef {
  finishedGoodBatchId: string;
  batchNumber: string | null;
  producedQty: string | null;
  productSkuId: string | null;
  status: string | null;
}

/**
 * Packaging-owned stock facts for one FG batch: how much was produced and how much is currently
 * held by active reservations. The DISPATCHED total lives in the sales cluster, so a caller that
 * needs true available-to-promise (e.g. the dispatch guard) nets its own dispatched sum against
 * these: available = producedQty − reservedQty − dispatched.
 */
export interface FinishedGoodStockRef {
  finishedGoodBatchId: string;
  producedQty: string | null;
  reservedQty: string; // sum of ACTIVE (released_dt IS NULL) reservations, '0' if none
  qcFailed: boolean; // latest packaging QC verdict is FAIL → not sellable/dispatchable
}

/** Cold read port into package orders + finished-good batches + FG stock facts. */
export interface PackagingLookup {
  getPackageOrder(packageOrderId: string): Promise<PackageOrderRef | null>;
  getFinishedGoodBatch(finishedGoodBatchId: string): Promise<FinishedGoodBatchRef | null>;
  getFinishedGoodStock(finishedGoodBatchId: string): Promise<FinishedGoodStockRef | null>;
}

/** DI token for `PackagingLookup`. */
export const PACKAGING_LOOKUP = Symbol('PACKAGING_LOOKUP');
