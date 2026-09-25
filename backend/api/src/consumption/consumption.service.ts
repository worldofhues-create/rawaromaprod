/**
 * ConsumptionService (audit H-C3) — the inventory-side reaction to production material issues.
 * Runs in the worker. Production issues materials against an order but cannot write the inventory
 * schema (cluster boundary), so this is a second outbox consumer (same pattern as the email
 * notifier): it polls `production.materials.issued`, and for each NEW issue decrements the issued
 * inventory batches' on-hand by the pick-list quantity, in ONE transaction, recording an
 * inventory_event_history row. Idempotent via the `inventory.material_issue_applied` ledger (each
 * issue is applied exactly once). The migration backfills existing issues, so only issues raised
 * after go-live are consumed — history is never retroactively decremented.
 *
 * Quantity source: material_issue_item.issued_qty is a BOOLEAN (dictionary-locked), so the real
 * quantity comes from the linked material_pick_list_items.picked_qty; the batch to decrement is the
 * issue line's inventory_batch_id (what was actually taken).
 *
 * RP-PROD-004: the `inventory.material_issue_applied` row inserted below is a single-applier
 * CLAIM, not just a dedupe marker — MixingService.abortSession (backend/cluster-production/src/
 * mixing/mixing.service.ts) races this same INSERT ... ON CONFLICT DO NOTHING against the same
 * primary key to cancel an issue before it's ever debited. Whichever side's transaction commits
 * the claim row first wins: if abort wins, this method's own claim finds the row already there
 * and returns without touching inventory (the issue is void, never debited — correct); if this
 * method wins, abort's claim attempt finds the row already there and instead reads back the
 * inventory_event_history rows this method writes (via event_qty) to credit the exact amount
 * taken. Postgres serializes the two INSERTs on the shared PK, so there is no window where both
 * sides believe they're first.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';

@Injectable()
export class ConsumptionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsumptionService.name);
  private readonly pollMs = Number(process.env.CONSUMPTION_POLL_MS) || 6000;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
    this.logger.log(`consumption subscriber: production.materials.issued every ${this.pollMs}ms`);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = (await this.sql`
        select o.aggregate_id::text as issue_id
        from production.outbox o
        where o.type = 'production.materials.issued'
          and o.aggregate_id is not null
          and not exists (
            select 1 from inventory.material_issue_applied a where a.material_issue_id = o.aggregate_id
          )
        order by o.occurred_at asc
        limit 50`) as Array<{ issue_id: string }>;
      for (const e of events) await this.applyIssue(e.issue_id);
    } catch (err) {
      this.logger.warn(`consumption drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Decrement RM on-hand for one material issue, exactly once (ledger-guarded, atomic). */
  private async applyIssue(issueId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Claim the issue — this row is the single-applier lock; a prior run already handled it.
      const claim = await tx`
        insert into inventory.material_issue_applied (material_issue_id, applied_dt)
        values (${issueId}, now())
        on conflict (material_issue_id) do nothing
        returning material_issue_id`;
      if (!claim.length) return;

      // Issued lines: the batch actually taken + the planned quantity (from the pick list).
      const lines = (await tx`
        select mii.inventory_batch_id::text as inv_batch, mpli.picked_qty::text as qty,
               mi.production_order_id::text as order_id
        from production.material_issue mi
        join production.material_issue_item mii on mii.material_issue_id = mi.material_issue_id
        left join production.material_pick_list_items mpli
          on mpli.material_pick_list_id = mi.material_pick_list_id and mpli.material_id = mii.material_id
        where mi.material_issue_id = ${issueId}`) as Array<{ inv_batch: string | null; qty: string | null; order_id: string | null }>;

      let applied = 0;
      for (const l of lines) {
        const qty = Number(l.qty);
        if (!l.inv_batch || !(qty > 0)) continue; // need a known batch AND a known qty to decrement
        await tx`
          update inventory.inventory_batch
             set quantity_on_hand = coalesce(quantity_on_hand, 0) - ${qty}, updated_dt = now()
           where inventory_batch_id = ${l.inv_batch}`;
        await tx`
          insert into inventory.inventory_event_history
            (inventory_batch_id, event_type, event_dt, reference_document_id, reference_document_type, event_qty, remarks, status)
          values (${l.inv_batch}, 'PRODUCTION_ISSUE', now(), ${issueId}, 'MATERIAL_ISSUE', ${qty}, ${`issued ${qty} to production`}, 'ACTIVE')`;
        // OPS-GREEN Act L (lane ops-factory): reserve -> pick -> issue. The RM reservation the
        // planner held on THIS batch for THIS production order is consumed by the issue, in the
        // same transaction as the debit — otherwise it outlives the stock it reserved and every
        // later reservation on the batch reads on-hand minus a hold that no longer exists.
        if (l.order_id) {
          await tx`
            update inventory.stock_reservation
               set released_dt = now(), status = 'CONSUMED', updated_by = 'consumption:material_issue', updated_dt = now()
             where inventory_batch_id = ${l.inv_batch} and reserved_for_document_id = ${l.order_id}
               and released_dt is null`;
        }
        applied++;
      }
      await tx`update inventory.material_issue_applied set item_count = ${applied} where material_issue_id = ${issueId}`;
      if (applied) this.logger.log(`consumption: issue ${issueId.slice(0, 8)} → ${applied} batch(es) decremented`);
    });
  }
}
