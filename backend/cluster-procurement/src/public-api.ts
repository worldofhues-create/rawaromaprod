/**
 * procurement cluster — PUBLIC API.
 *
 * The only surface other clusters may import from cluster-procurement. Cross-cluster reads
 * go through this cold-read port (inject by token); never a deep import into a service or
 * the schema. Resolvers return id + code/name/status refs only — no meta tail, no bodies.
 */

/** A minimal vendor view for cross-cluster resolution. */
export interface VendorRef {
  vendorId: string;
  vendorCode: string | null;
  vendorName: string | null;
}

/** A minimal purchase-order view for cross-cluster resolution. */
export interface PurchaseOrderRef {
  purchaseOrderId: string;
  poNumber: string | null;
  vendorId: string | null;
  status: string | null;
}

/** Cold-read port into the procurement cluster. */
export interface ProcurementLookup {
  /** Resolve a vendor by id (code/name refs only), or null if absent. */
  findVendor(vendorId: string): Promise<VendorRef | null>;
  /** Resolve a purchase order by id (number/vendor/status refs only), or null if absent. */
  findPurchaseOrder(poId: string): Promise<PurchaseOrderRef | null>;
}

/** DI token for `ProcurementLookup`. Consumers: `@Inject(PROCUREMENT_LOOKUP)`. */
export const PROCUREMENT_LOOKUP = Symbol('PROCUREMENT_LOOKUP');
