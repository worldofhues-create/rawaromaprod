/**
 * sales cluster — PUBLIC API. Other clusters (inventory, fulfilment, finance) occasionally
 * need a cold read of a sales order or dispatch header to gate a downstream action. The only
 * surface we expose is the `SalesLookup` read port (ids + key scalars only). Inject by the
 * `SALES_LOOKUP` token; never sync-import the cluster itself.
 */

export interface SalesOrderRef {
  salesOrderId: string;
  soNumber: string | null;
  customerId: string | null;
  status: string | null;
}

export interface DispatchRef {
  dispatchId: string;
  salesOrderId: string | null;
  customerId: string | null;
  status: string | null;
}

/** Cold read port into the sales orders + dispatches. */
export interface SalesLookup {
  getSalesOrder(salesOrderId: string): Promise<SalesOrderRef | null>;
  getDispatch(dispatchId: string): Promise<DispatchRef | null>;
}

/** DI token for `SalesLookup`. */
export const SALES_LOOKUP = Symbol('SALES_LOOKUP');
