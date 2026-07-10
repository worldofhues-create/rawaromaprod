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
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PACKAGING_LOOKUP, type PackagingLookup } from '@ra/cluster-packaging';
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
  constructor(
    @Inject(SALES_DB) private readonly db: SalesDb,
    @Inject(PACKAGING_LOOKUP) private readonly packaging: PackagingLookup,
  ) {}

  /**
   * Finished-goods available-to-promise for one FG batch, netted across the schema boundary.
   * produced + reserved come from the packaging cluster's cold-read port; already-dispatched is
   * this cluster's own sum (non-cancelled lines). available = produced − reserved − dispatched.
   * Throws NotFound for an unknown batch. Best-effort (read outside the write tx) — acceptable at
   * Phase-1 concurrency; the true single-writer guard lands with the offline factory console.
   */
  private async fgAvailable(finishedGoodBatchId: string): Promise<number> {
    const stock = await this.packaging.getFinishedGoodStock(finishedGoodBatchId);
    if (!stock) {
      throw new NotFoundException(`finished-good batch not found: ${finishedGoodBatchId}`);
    }
    // A batch that failed packaging QC is not dispatchable (audit H-I2) — available is 0.
    if (stock.qcFailed) return 0;
    const produced = Number(stock.producedQty ?? 0);
    const reserved = Number(stock.reservedQty ?? 0);
    const consumed = Number(stock.consumedQty ?? 0); // align with the ATP read-model (audit G/#9)
    const dispatchedRow = (
      await this.db
        .select({ total: sql<string>`coalesce(sum(${dispatchItems.dispatchedQty}), 0)::text` })
        .from(dispatchItems)
        .where(
          and(
            eq(dispatchItems.finishedGoodBatchId, finishedGoodBatchId),
            ne(dispatchItems.status, 'CANCELLED'),
          ),
        )
    )[0];
    const alreadyDispatched = Number(dispatchedRow?.total ?? 0);
    return produced - reserved - consumed - alreadyDispatched;
  }

  /* ── flow: create dispatch with items ─────────────────────────────── */

  /**
   * POST /v1/dispatches — insert the dispatch header + one line per item, then emit
   * `sales.dispatch.created`. All in one transaction so the event publishes iff the header +
   * lines committed. Before writing, every FG-batch line is checked against available-to-promise
   * and over-dispatch is rejected (409) — you cannot ship more than produced − reserved − already
   * dispatched.
   */
  async createDispatch(body: CreateDispatch, principal: AuthPrincipal) {
    // Pre-flight availability guard: reject non-positive qty, AGGREGATE the requested qty per FG
    // batch across lines (so two lines for one batch can't each pass the full-available check),
    // then reject if a batch's total exceeds available (audit G/#9).
    const perBatch = new Map<string, number>();
    for (const it of body.items) {
      if (!it.finishedGoodBatchId || it.dispatchedQty == null) continue;
      if (!(it.dispatchedQty > 0)) {
        throw new ConflictException(`Dispatch quantity must be positive (got ${it.dispatchedQty}).`);
      }
      perBatch.set(it.finishedGoodBatchId, (perBatch.get(it.finishedGoodBatchId) ?? 0) + it.dispatchedQty);
    }
    for (const [batchId, requested] of perBatch) {
      const available = await this.fgAvailable(batchId);
      if (requested > available) {
        throw new ConflictException(
          `Cannot dispatch ${requested} of finished-good batch ${batchId}: only ${available} available (produced − reserved − consumed − already dispatched).`,
        );
      }
    }

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

  async listDispatches(query: ListQuery): Promise<Page<Record<string, unknown>>> {
    // Enriched with SO number + customer + a composite label so the list is readable and the
    // dispatch-document picker can identify the dispatch (customers aren't secret).
    const rows = (await this.db.execute(sql`
      select dm.dispatch_id as "dispatchId", dm.sales_order_id as "salesOrderId", so.so_number as "soNumber",
             dm.customer_id as "customerId", c.customer_name as "customerName",
             dm.dispatch_date as "dispatchDate", dm.vehicle_number as "vehicleNumber", dm.status as "status",
             coalesce(so.so_number, '') || ' · ' || coalesce(c.customer_name, '?') || ' · ' || coalesce(dm.dispatch_date::text, '') as "label"
        from sales.dispatch_master dm
        left join sales.sales_order so on so.sales_order_id = dm.sales_order_id
        left join sales.customer_master c on c.customer_id = dm.customer_id
       ${query.cursor ? sql`where dm.dispatch_id < ${query.cursor}` : sql``}
       order by dm.dispatch_id desc
       limit ${query.limit + 1}`)) as unknown as Array<Record<string, unknown>>;
    return paginate(Array.from(rows), query.limit, (r) => r.dispatchId as string);
  }

  async getDispatch(id: string) {
    return (
      await this.db.select().from(dispatchMaster).where(eq(dispatchMaster.dispatchId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── dispatch items (CRUD) ────────────────────────────────────────── */

  async createDispatchItem(body: CreateDispatchItem, principal: AuthPrincipal) {
    // Same availability guard as createDispatch (audit G/#9): this standalone line-add endpoint was
    // a bypass around the over-dispatch check.
    if (body.finishedGoodBatchId && body.dispatchedQty != null) {
      if (!(body.dispatchedQty > 0)) {
        throw new ConflictException(`Dispatch quantity must be positive (got ${body.dispatchedQty}).`);
      }
      const available = await this.fgAvailable(body.finishedGoodBatchId);
      if (body.dispatchedQty > available) {
        throw new ConflictException(
          `Cannot dispatch ${body.dispatchedQty} of finished-good batch ${body.finishedGoodBatchId}: only ${available} available.`,
        );
      }
    }
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
