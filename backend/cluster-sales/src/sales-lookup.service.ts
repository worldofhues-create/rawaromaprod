/**
 * SalesLookupService — in-cluster implementation of the `SalesLookup` public port. Provided
 * under `SALES_LOOKUP` so consumers depend only on the interface, never on a concrete class.
 * Keyed selects returning id + key scalars for a sales order / dispatch header.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { SALES_DB, salesSchema, type SalesDb } from './sales.tokens.js';
import type { DispatchRef, SalesLookup, SalesOrderRef } from './public-api.js';

const { salesOrder, dispatchMaster } = salesSchema;

@Injectable()
export class SalesLookupService implements SalesLookup {
  constructor(@Inject(SALES_DB) private readonly db: SalesDb) {}

  async getSalesOrder(salesOrderId: string): Promise<SalesOrderRef | null> {
    const row = (
      await this.db
        .select({
          salesOrderId: salesOrder.salesOrderId,
          soNumber: salesOrder.soNumber,
          customerId: salesOrder.customerId,
          status: salesOrder.status,
        })
        .from(salesOrder)
        .where(eq(salesOrder.salesOrderId, salesOrderId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async getDispatch(dispatchId: string): Promise<DispatchRef | null> {
    const row = (
      await this.db
        .select({
          dispatchId: dispatchMaster.dispatchId,
          salesOrderId: dispatchMaster.salesOrderId,
          customerId: dispatchMaster.customerId,
          status: dispatchMaster.status,
        })
        .from(dispatchMaster)
        .where(eq(dispatchMaster.dispatchId, dispatchId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
