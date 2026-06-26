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

/** Cold read port into package orders + finished-good batches. */
export interface PackagingLookup {
  getPackageOrder(packageOrderId: string): Promise<PackageOrderRef | null>;
  getFinishedGoodBatch(finishedGoodBatchId: string): Promise<FinishedGoodBatchRef | null>;
}

/** DI token for `PackagingLookup`. */
export const PACKAGING_LOOKUP = Symbol('PACKAGING_LOOKUP');
