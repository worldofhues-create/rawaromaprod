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
 * STOCK-UNITS: the pick line and the lot each name their own unit, and on-hand is kept in the lot's.
 * The old debit subtracted the pick number as it stood, so 125.5 g off a kg lot took 125.5 kg. Each
 * line now converts exactly (convertQty) and event_qty is written in the lot's unit, which is what
 * lets an abort credit it back unchanged. A line that does not convert refuses the WHOLE issue:
 * nothing is debited and nothing is claimed, so the issue stays open and debits once the unit is put
 * right. PickingService.issueMaterials refuses first; this is the last guard, for an issue already
 * raised. The refusal goes on the lot's history once, as PRODUCTION_ISSUE_REFUSED.
 *
 * Quantity source: material_issue_item.issued_qty is a BOOLEAN (dictionary-locked), so the real
 * quantity comes from the linked material_pick_list_items.picked_qty; the batch to decrement is the
 * issue line's inventory_batch_id (what was actually taken).
 *
 * STOCK2-2: linked by pick line (material_issue_item.material_pick_list_item_id), never by material:
 * one material on two lines joined twice and debited each line for both. An older row with no link
 * still matches by material while exactly one line carries it; two refuse rather than guess.
 *
 * STOCK2-1: stock leaves at the pick, so the debit stays here, but what it ends on is the verifier's
 * weight. A floor line verified before this runs is debited at floor_line.actual_mg; one verified
 * after is trued up by FloorStationService from floor_line.debited_mg, which this writes. The lines
 * are locked before actual_mg is read and verifyLine writes actual_mg before reading debited_mg, so
 * whichever transaction commits second sees the other: the weight lands exactly once.
 *
 * STOCK2-4: a refusal is also an open floor alert with the next action, closed by the first drain
 * after the issue is settled either way (debited, or voided by an abort).
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
import { convertQty, mgToQty } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { raiseAlert } from '../floor-ops/floor-alerts.js';

/** A line of the issue does not convert to its lot's unit: rolls the whole debit back. */
class UnitRefused extends Error {
  constructor(readonly batchId: string, message: string) { super(message); }
}

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
      await this.closeSettledAlerts();
      const events = (await this.sql`
        select o.aggregate_id::text as issue_id
        from production.outbox o
        where o.type = 'production.materials.issued'
          and o.aggregate_id is not null
          and not exists (
            select 1 from inventory.material_issue_applied a where a.material_issue_id = o.aggregate_id
          )
        order by exists (
            select 1 from inventory.inventory_event_history h
             where h.reference_document_id = o.aggregate_id and h.event_type = 'PRODUCTION_ISSUE_REFUSED'
          ), o.occurred_at asc
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
    try {
      await this.debit(issueId);
    } catch (err) {
      if (!(err instanceof UnitRefused)) throw err;
      this.logger.warn(`consumption: issue ${issueId.slice(0, 8)} refused: ${err.message}`);
      await this.sql`
        insert into inventory.inventory_event_history
          (inventory_batch_id, event_type, event_dt, reference_document_id, reference_document_type, remarks, status)
        select ${err.batchId}, 'PRODUCTION_ISSUE_REFUSED', now(), ${issueId}, 'MATERIAL_ISSUE', ${err.message}, 'ACTIVE'
         where not exists (select 1 from inventory.inventory_event_history
                            where reference_document_id = ${issueId} and event_type = 'PRODUCTION_ISSUE_REFUSED')`;
      await this.alertRefusal(issueId, err.message);
    }
  }

  /** STOCK2-4: every station reads these, so codes and units only: never a material name. */
  private async alertRefusal(issueId: string, reason: string): Promise<void> {
    const [o] = (await this.sql`
      select po.order_number, j.job_no from production.material_issue mi
        left join production.production_order po on po.production_order_id = mi.production_order_id
        left join production.floor_job j on j.production_order_id = mi.production_order_id
       where mi.material_issue_id = ${issueId}`) as Array<{ order_number: string | null; job_no: string | null }>;
    const what = o?.job_no ?? o?.order_number ?? 'A material issue';
    await raiseAlert(this.sql, {
      kind: 'STOCK_DEBIT_REFUSED', station: 'Floor', subjectType: 'MATERIAL_ISSUE', subjectId: issueId,
      title: `${what} has not been taken off stock`,
      body: `${reason} Next: a supervisor corrects the unit on the pick line or the lot. The debit then runs by itself and this alert closes. Until then the lot shows more than the shelf holds.`,
      dedupeKey: `stock_debit_refused:${issueId}`,
    }, new Date());
  }

  private async closeSettledAlerts(): Promise<void> {
    await this.sql`
      update platform.floor_alert a set cleared_at = now()
       where a.kind = 'STOCK_DEBIT_REFUSED' and a.cleared_at is null
         and exists (select 1 from inventory.material_issue_applied x where x.material_issue_id = a.subject_id)`;
  }

  private async debit(issueId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Claim the issue — this row is the single-applier lock; a prior run already handled it.
      const claim = await tx`
        insert into inventory.material_issue_applied (material_issue_id, applied_dt)
        values (${issueId}, now())
        on conflict (material_issue_id) do nothing
        returning material_issue_id`;
      if (!claim.length) return;

      // Issued lines: the batch actually taken + the planned quantity (from the pick list).
      const rows = (await tx`
        select mii.material_issue_item_id::text as item_id, mii.inventory_batch_id::text as inv_batch, mpli.picked_qty::text as qty,
               mpli.material_pick_list_item_id::text as line_id,
               mi.production_order_id::text as order_id, pu.uom_code as pick_uom, lu.uom_code as lot_uom
        from production.material_issue mi
        join production.material_issue_item mii on mii.material_issue_id = mi.material_issue_id
        left join production.material_pick_list_items mpli
          on mpli.material_pick_list_item_id = mii.material_pick_list_item_id
          or (mii.material_pick_list_item_id is null and mpli.material_pick_list_id = mi.material_pick_list_id and mpli.material_id = mii.material_id)
        left join platform.uom_master pu on pu.uom_id = mpli.uom_id
        left join inventory.inventory_batch ib on ib.inventory_batch_id = mii.inventory_batch_id
        left join platform.uom_master lu on lu.uom_id = ib.uom_id
        where mi.material_issue_id = ${issueId}`) as Array<{ item_id: string; inv_batch: string | null; qty: string | null; line_id: string | null; order_id: string | null; pick_uom: string | null; lot_uom: string | null }>;

      const seen = new Set<string>();
      for (const r of rows) {
        if (r.inv_batch && seen.has(r.item_id)) throw new UnitRefused(r.inv_batch, 'This issue names a material that is on 2 lines of the pick list, and not which line, so the quantity cannot be told.');
        seen.add(r.item_id);
      }

      // STOCK2-1: locked before actual_mg is read. See the note at the top of this file.
      const lineIds = rows.flatMap((r) => (r.line_id ? [r.line_id] : []));
      const floor = new Map((await tx`
        select material_pick_list_item_id::text as line_id, target_mg::text, actual_mg::text
          from production.floor_line where material_pick_list_item_id = any(${lineIds}::uuid[]) for update`
      ).map((f) => [f.line_id as string, f as unknown as { target_mg: string; actual_mg: string | null }]));

      let applied = 0;
      for (const l of rows) {
        if (!l.inv_batch || !(Number(l.qty) > 0)) continue; // need a known batch AND a known qty to decrement
        const fl = l.line_id ? floor.get(l.line_id) : undefined;
        let moved = convertQty(l.qty, l.pick_uom, l.lot_uom);
        if (fl?.actual_mg != null) {
          const verified = mgToQty(Number(fl.actual_mg), l.lot_uom);
          moved = verified === null ? { refused: `A lot kept in ${l.lot_uom} cannot hold the verified weight exactly.` } : { qty: verified };
        }
        if ('refused' in moved) throw new UnitRefused(l.inv_batch, moved.refused);
        const qty = moved.qty; // exact text in the lot's unit: never through a float
        if (fl) await tx`update production.floor_line set debited_mg = ${fl.actual_mg ?? fl.target_mg} where material_pick_list_item_id = ${l.line_id}`;
        await tx`
          update inventory.inventory_batch
             set quantity_on_hand = coalesce(quantity_on_hand, 0) - ${qty}::numeric, updated_dt = now()
           where inventory_batch_id = ${l.inv_batch}`;
        await tx`
          insert into inventory.inventory_event_history
            (inventory_batch_id, event_type, event_dt, reference_document_id, reference_document_type, event_qty, remarks, status)
          values (${l.inv_batch}, 'PRODUCTION_ISSUE', now(), ${issueId}, 'MATERIAL_ISSUE', ${qty}, ${`issued ${qty} ${l.lot_uom} to production (${l.qty} ${l.pick_uom} on the pick list${fl?.actual_mg != null ? ', verified weight taken' : ''})`}, 'ACTIVE')`;
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
