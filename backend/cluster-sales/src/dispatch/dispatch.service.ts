/**
 * DispatchService — the dispatch document + its child lines: DISPATCH_MASTER, DISPATCH_ITEMS.
 * CRUD for both, plus the dispatch FLOW:
 *
 *   createDispatch → insert the dispatch_master header + one dispatch_items per line, all in
 *                    ONE transaction, then record a `sales.dispatch.created` outbox event.
 *
 * Pre-generated ids use uuidv7(); status defaults to ACTIVE; created_by/updated_by =
 * principal.userId; dispatched_qty is stringified at insert (num()); dispatch_date is a plain
 * date string. sales_order / customer / sales_order_item / transporter / finished_good_batch /
 * uom are dict-soft refs (plain uuid, no FK at this layer); dispatch_items.dispatch_id is the
 * one real in-schema FK.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { SALES_DB, salesSchema, type SalesDb } from '../sales.tokens.js';
import { salesEvents } from '../sales.events.js';
import { num, paginate, type Page } from '../_helpers.js';
import type {
  CreateDispatch,
  CreateDispatchItem,
  ListQuery,
} from '../sales.dtos.js';

const { dispatchMaster, dispatchItems, outbox } = salesSchema;

@Injectable()
export class DispatchService {
  constructor(@Inject(SALES_DB) private readonly db: SalesDb) {}

  /* ── flow: create dispatch with items ─────────────────────────────── */

  /**
   * POST /v1/dispatches — insert the dispatch header + one line per item, then emit
   * `sales.dispatch.created`. All in one transaction so the event publishes iff the header +
   * lines committed.
   */
  async createDispatch(body: CreateDispatch, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const dispatchId = uuidv7();
      const header = (
        await tx
          .insert(dispatchMaster)
          .values({
            dispatchId,
            salesOrderId: body.salesOrderId,
            customerId: body.customerId ?? null,
            dispatchDate: body.dispatchDate ?? null,
            vehicleNumber: body.vehicleNumber ?? null,
            transporterId: body.transporterId ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!header) throw new Error('insert failed: dispatch_master');

      const lineValues = body.items.map((it) => ({
        dispatchItemId: uuidv7(),
        dispatchId,
        salesOrderItemId: it.salesOrderItemId ?? null,
        finishedGoodBatchId: it.finishedGoodBatchId ?? null,
        dispatchedQty: num(it.dispatchedQty),
        uomId: it.uomId ?? null,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      }));
      const items = await tx.insert(dispatchItems).values(lineValues).returning();

      await recordOutbox(
        tx,
        outbox,
        salesEvents.dispatchCreated,
        { dispatchId, salesOrderId: body.salesOrderId },
        dispatchId,
      );

      return { dispatch: header, items };
    });
  }

  /* ── dispatch master (CRUD reads) ─────────────────────────────────── */

  async listDispatches(query: ListQuery): Promise<Page<typeof dispatchMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(dispatchMaster)
      .where(query.cursor ? lt(dispatchMaster.dispatchId, query.cursor) : undefined)
      .orderBy(desc(dispatchMaster.dispatchId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.dispatchId);
  }

  async getDispatch(id: string) {
    return (
      await this.db.select().from(dispatchMaster).where(eq(dispatchMaster.dispatchId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── dispatch items (CRUD) ────────────────────────────────────────── */

  async createDispatchItem(body: CreateDispatchItem, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(dispatchItems)
        .values({
          dispatchItemId: uuidv7(),
          dispatchId: body.dispatchId,
          salesOrderItemId: body.salesOrderItemId ?? null,
          finishedGoodBatchId: body.finishedGoodBatchId ?? null,
          dispatchedQty: num(body.dispatchedQty),
          uomId: body.uomId ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: dispatch_items');
    return row;
  }

  async listDispatchItems(query: ListQuery): Promise<Page<typeof dispatchItems.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(dispatchItems)
      .where(query.cursor ? lt(dispatchItems.dispatchItemId, query.cursor) : undefined)
      .orderBy(desc(dispatchItems.dispatchItemId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.dispatchItemId);
  }

  async getDispatchItem(id: string) {
    return (
      await this.db
        .select()
        .from(dispatchItems)
        .where(eq(dispatchItems.dispatchItemId, id))
        .limit(1)
    )[0] ?? null;
  }
}
