/**
 * ProcurementLookupService — in-cluster implementation of the `ProcurementLookup` public
 * port. Provided under `PROCUREMENT_LOOKUP` so consumers depend only on the interface.
 * Cold-read resolvers return id + code/name/status refs only — no meta tail, no bodies.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  PROCUREMENT_DB,
  procurementSchema,
  type ProcurementDb,
} from './cluster-procurement.tokens.js';
import type {
  ProcurementLookup,
  PurchaseOrderRef,
  VendorRef,
} from './public-api.js';

const { vendorDetails, purchaseOrder } = procurementSchema;

@Injectable()
export class ProcurementLookupService implements ProcurementLookup {
  constructor(@Inject(PROCUREMENT_DB) private readonly db: ProcurementDb) {}

  async findVendor(vendorId: string): Promise<VendorRef | null> {
    const row = (
      await this.db
        .select({
          vendorId: vendorDetails.vendorId,
          vendorCode: vendorDetails.vendorCode,
          vendorName: vendorDetails.vendorName,
        })
        .from(vendorDetails)
        .where(eq(vendorDetails.vendorId, vendorId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findPurchaseOrder(poId: string): Promise<PurchaseOrderRef | null> {
    const row = (
      await this.db
        .select({
          purchaseOrderId: purchaseOrder.purchaseOrderId,
          poNumber: purchaseOrder.poNumber,
          vendorId: purchaseOrder.vendorId,
          status: purchaseOrder.status,
        })
        .from(purchaseOrder)
        .where(eq(purchaseOrder.purchaseOrderId, poId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
