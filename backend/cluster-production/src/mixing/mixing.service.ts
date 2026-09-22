/**
 * MixingService — secure mixing: SECURE_MIXING_SESSION, MIXING_STEP_LOG. CRUD reads for both,
 * plus the session flow:
 *
 *   startSession → open an IN_PROGRESS session against a production order.
 *   logStep      → append a mixing_step_log row to a session.
 *   endSession   → CAS IN_PROGRESS→COMPLETED (RP-FAC2: was an unconditional PATCH — a session
 *                  could be "completed" twice, or completed after it was already aborted).
 *   abortSession → CAS IN_PROGRESS→ABORTED (RP-FAC2 / RP-PROD-003: this session had NO fail/abort
 *                  path at all — a botched mix could only ever be silently left IN_PROGRESS
 *                  forever, or force-completed). Reverses the inventory side effects of whatever
 *                  was already issued for this session's production order, resets
 *                  production_order_ingredients.issued_qty back to false, marks the reversed
 *                  material_issue/material_issue_item rows VOID or REVERSED, and releases any
 *                  open RM stock_reservation held against this production order — all inside ONE
 *                  transaction with the mixing_step_log ABORT row, so the reversal is never
 *                  partially applied.
 *
 *                  RP-PROD-004 (HIGH, found by reviewer R1): the original reversal credited
 *                  inventory.inventory_batch.quantity_on_hand by production_order_ingredients.
 *                  required_qty for every ingredient PickingService.issueMaterials had flagged
 *                  issued_qty=true — but issueMaterials never debits inventory at all; the debit
 *                  is done asynchronously, later, by ConsumptionService (backend/api/src/
 *                  consumption/consumption.service.ts, an outbox poller) from
 *                  material_pick_list_items.picked_qty. So aborting before the poller ever ran
 *                  credited stock that had never left, and an issue raised with no pick list
 *                  (materialPickListId was optional) was NEVER debited by the poller at all — an
 *                  abort on it still credited required_qty, minting unbounded phantom stock on
 *                  repeat. Even once debited, required_qty (planned) and picked_qty (actual) can
 *                  differ, and an abort could race the poller's own debit.
 *
 *                  Fixed by crediting from the real applied ledger instead of the plan:
 *                  inventory.inventory_event_history rows ConsumptionService itself writes
 *                  (event_type='PRODUCTION_ISSUE', reference_document_id=material_issue_id,
 *                  event_qty=exact qty taken per batch — see RP-PROD-004 on that table). Abort
 *                  and the consumer both race the SAME single-applier claim row insert into
 *                  inventory.material_issue_applied (material_issue_id PK, ON CONFLICT DO
 *                  NOTHING): whichever commits first wins — if abort wins, the issue is marked
 *                  VOID with nothing credited (nothing was ever debited, and the consumer's own
 *                  later claim attempt will now find the row and skip it forever); if the
 *                  consumer wins, abort reads its committed inventory_event_history rows and
 *                  credits back exactly that, per batch, then marks the issue REVERSED. Postgres
 *                  serializes the two INSERTs on the shared PK, so there is no window where a
 *                  debit lands after abort has already decided nothing was applied — and
 *                  PickingService.issueMaterials now refuses an issue with no materialPickListId
 *                  outright (production can't debit inventory itself — cluster boundary — so an
 *                  issue the consumer can never price is refused at the source instead of relying
 *                  on this reversal to paper over it).
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; ISO timestamps →
 * Date. order/operator/stage/user refs are id-only soft refs (plain uuid, no FK at this layer).
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { emitBridgeOutbound, recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, type Page } from '../_helpers.js';
import type {
  AbortMixingSession,
  CreateMixingSession,
  EndMixingSession,
  ListQuery,
  LogStep,
} from '../production.dtos.js';

const { secureMixingSession, mixingStepLog, productionOrderIngredients, outbox } = productionSchema;

@Injectable()
export class MixingService {
  constructor(@Inject(PRODUCTION_DB) private readonly db: ProductionDb) {}

  /* ── secure mixing session ───────────────────────────────────────── */

  /** POST /v1/mixing-sessions — open a session. Wrapped in a transaction (RP-EMIT, lane
   *  F6) so the session insert and the ProductionStarted emission toward ALEMBIC (when
   *  this order fulfills a bridge requirement) commit or roll back together. */
  async startSession(body: CreateMixingSession, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const row = (
        await tx
          .insert(secureMixingSession)
          .values({
            secureMixingSessionId: uuidv7(),
            productionOrderId: body.productionOrderId,
            operatorId: body.operatorId ?? null,
            sessionStartDt: body.sessionStartDt ? new Date(body.sessionStartDt) : new Date(),
            status: 'IN_PROGRESS',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!row) throw new Error('insert failed: secure_mixing_session');

      await emitBridgeOutbound(tx, 'ProductionStarted', body.productionOrderId, {
        production_order_id: body.productionOrderId,
        secure_mixing_session_id: row.secureMixingSessionId,
      });

      return row;
    });
  }

  async listSessions(query: ListQuery): Promise<Page<typeof secureMixingSession.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(secureMixingSession)
      .where(
        query.cursor ? lt(secureMixingSession.secureMixingSessionId, query.cursor) : undefined,
      )
      .orderBy(desc(secureMixingSession.secureMixingSessionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.secureMixingSessionId);
  }

  async getSession(id: string) {
    return (
      await this.db
        .select()
        .from(secureMixingSession)
        .where(eq(secureMixingSession.secureMixingSessionId, id))
        .limit(1)
    )[0] ?? null;
  }

  /* ── flow: log step ──────────────────────────────────────────────── */

  /** POST /v1/mixing-sessions/:id/steps — append a step log row. */
  async logStep(sessionId: string, body: LogStep, principal: AuthPrincipal) {
    const session = await this.getSession(sessionId);
    if (!session) throw new NotFoundException(`secure_mixing_session not found: ${sessionId}`);

    const row = (
      await this.db
        .insert(mixingStepLog)
        .values({
          mixingStepLogId: uuidv7(),
          secureMixingSessionId: sessionId,
          formulaStageId: body.formulaStageId ?? null,
          stepSequence: body.stepSequence ?? null,
          stepDescription: body.stepDescription ?? null,
          performedDt: body.performedDt ? new Date(body.performedDt) : new Date(),
          performedBy: body.performedBy ?? principal.userId,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: mixing_step_log');
    return row;
  }

  /* ── flow: end session ───────────────────────────────────────────── */

  /** POST /v1/mixing-sessions/:id/end — CAS IN_PROGRESS→COMPLETED, set session_end_dt. */
  async endSession(sessionId: string, body: EndMixingSession, principal: AuthPrincipal) {
    const session = await this.getSession(sessionId);
    if (!session) throw new NotFoundException(`secure_mixing_session not found: ${sessionId}`);

    const current = String(session.status ?? 'IN_PROGRESS').toUpperCase();
    if (current !== 'IN_PROGRESS') {
      throw new ConflictException(
        `Mixing session cannot be completed from status ${current} (must be IN_PROGRESS).`,
      );
    }

    const row = (
      await this.db
        .update(secureMixingSession)
        .set({
          sessionEndDt: body.sessionEndDt ? new Date(body.sessionEndDt) : new Date(),
          status: 'COMPLETED',
          updatedBy: principal.userId,
        })
        .where(
          and(
            eq(secureMixingSession.secureMixingSessionId, sessionId),
            eq(secureMixingSession.status, 'IN_PROGRESS'),
          ),
        )
        .returning()
    )[0];
    if (!row) {
      throw new ConflictException(
        `Mixing session ${sessionId} was moved off IN_PROGRESS by a concurrent request.`,
      );
    }
    return row;
  }

  /* ── flow: abort session (fail path + inventory reversal) ─────────── */

  /**
   * POST /v1/mixing-sessions/:id/abort — CAS IN_PROGRESS→ABORTED. Records the abort reason as a
   * mixing_step_log row, reverses any material_issue rows still ACTIVE against the session's
   * production order — crediting inventory.inventory_batch.quantity_on_hand back by exactly what
   * the consumption ledger (inventory.inventory_event_history) shows was actually debited, per
   * batch, never the order's planned required_qty — resets production_order_ingredients.
   * issued_qty, marks the issue VOID (nothing was ever debited) or REVERSED (credited back), and
   * releases any still-open inventory.stock_reservation held for that production order. One
   * transaction: the abort, the audit row, and every reversal commit or roll back together. See
   * the class-level RP-PROD-004 note for why (the old version assumed issueMaterials always
   * debited synchronously; it never does) and how the consumer race is interlocked.
   */
  async abortSession(sessionId: string, body: AbortMixingSession, principal: AuthPrincipal) {
    const session = await this.getSession(sessionId);
    if (!session) throw new NotFoundException(`secure_mixing_session not found: ${sessionId}`);

    const current = String(session.status ?? 'IN_PROGRESS').toUpperCase();
    if (current !== 'IN_PROGRESS') {
      throw new ConflictException(
        `Mixing session cannot be aborted from status ${current} (must be IN_PROGRESS).`,
      );
    }

    return this.db.transaction(async (tx) => {
      const updated = (
        await tx
          .update(secureMixingSession)
          .set({
            sessionEndDt: body.sessionEndDt ? new Date(body.sessionEndDt) : new Date(),
            status: 'ABORTED',
            updatedBy: principal.userId,
          })
          .where(
            and(
              eq(secureMixingSession.secureMixingSessionId, sessionId),
              eq(secureMixingSession.status, 'IN_PROGRESS'),
            ),
          )
          .returning()
      )[0];
      if (!updated) {
        throw new ConflictException(
          `Mixing session ${sessionId} was moved off IN_PROGRESS by a concurrent request; refusing this stale abort.`,
        );
      }

      // Audit: the abort reason is a first-class mixing_step_log row, not just a status flip.
      await tx.insert(mixingStepLog).values({
        mixingStepLogId: uuidv7(),
        secureMixingSessionId: sessionId,
        stepDescription: `ABORTED: ${body.reason}`,
        performedDt: new Date(),
        performedBy: principal.userId,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      const productionOrderId = updated.productionOrderId ?? null;
      let reversedIngredients = 0;
      if (productionOrderId) {
        // Every material_issue for this order that hasn't already been settled by a previous
        // abort (VOID) or previously credited (REVERSED). One issue at a time, so the
        // single-applier claim race below is scoped to exactly the row the consumer also keys
        // its own claim on.
        const issues = (await tx.execute(sql`
          select material_issue_id
            from production.material_issue
           where production_order_id = ${productionOrderId}
             and coalesce(status, 'ACTIVE') not in ('REVERSED', 'VOID')`)) as unknown as Array<{
          material_issue_id: string;
        }>;

        const reversedMaterialIds = new Set<string>();

        for (const { material_issue_id: issueId } of issues) {
          const items = (await tx.execute(sql`
            select material_issue_item_id, material_id
              from production.material_issue_item
             where material_issue_id = ${issueId}
               and issued_qty = true
               and coalesce(status, 'ACTIVE') <> 'REVERSED'`)) as unknown as Array<{
            material_issue_item_id: string;
            material_id: string | null;
          }>;
          if (items.length === 0) continue;

          // Single-applier claim: the SAME primary key ConsumptionService.applyIssue() claims
          // before it debits (see that file's RP-PROD-004 note). Postgres serializes concurrent
          // INSERTs on this PK, so exactly one side observes "claimed" for a given issue.
          const claim = (await tx.execute(sql`
            insert into inventory.material_issue_applied (material_issue_id, item_count, applied_dt)
            values (${issueId}, 0, now())
            on conflict (material_issue_id) do nothing
            returning material_issue_id`)) as unknown as Array<{ material_issue_id: string }>;

          if (claim.length > 0) {
            // We claimed it first: nothing was ever debited, and — because the row now exists —
            // the consumer's own later claim attempt will find it and skip the issue forever.
            // Nothing to credit.
            await tx.execute(sql`
              update production.material_issue
                 set status = 'VOID', updated_by = ${principal.userId}
               where material_issue_id = ${issueId}`);
          } else {
            // The consumer claimed it first (already applied, or applying in a transaction we
            // just waited on via the PK lock — either way its rows are now committed and
            // visible). Credit back exactly what it debited, per batch, from the real ledger —
            // never the plan.
            const applied = (await tx.execute(sql`
              select inventory_batch_id, coalesce(sum(event_qty), 0)::text as qty
                from inventory.inventory_event_history
               where reference_document_id = ${issueId}
                 and reference_document_type = 'MATERIAL_ISSUE'
                 and event_type = 'PRODUCTION_ISSUE'
               group by inventory_batch_id`)) as unknown as Array<{
              inventory_batch_id: string | null;
              qty: string;
            }>;

            for (const row of applied) {
              const qty = Number(row.qty);
              if (!row.inventory_batch_id || !(qty > 0)) continue;
              await tx.execute(sql`
                update inventory.inventory_batch
                   set quantity_on_hand = coalesce(quantity_on_hand, 0) + ${qty}
                 where inventory_batch_id = ${row.inventory_batch_id}`);
              await tx.execute(sql`
                insert into inventory.inventory_event_history
                  (inventory_batch_id, event_type, event_dt, reference_document_id,
                   reference_document_type, event_qty, performed_by, remarks, status)
                values (${row.inventory_batch_id}, 'PRODUCTION_ISSUE_REVERSAL', now(), ${issueId},
                        'MATERIAL_ISSUE', ${qty}, ${principal.userId},
                        'mixing session abort credit', 'ACTIVE')`);
            }

            await tx.execute(sql`
              update production.material_issue
                 set status = 'REVERSED', updated_by = ${principal.userId}
               where material_issue_id = ${issueId}`);
          }

          await tx.execute(sql`
            update production.material_issue_item
               set status = 'REVERSED', updated_by = ${principal.userId}
             where material_issue_id = ${issueId} and issued_qty = true`);

          for (const item of items) {
            if (item.material_id) reversedMaterialIds.add(item.material_id);
          }
        }

        for (const materialId of reversedMaterialIds) {
          await tx
            .update(productionOrderIngredients)
            .set({ issuedQty: false, updatedBy: principal.userId })
            .where(
              and(
                eq(productionOrderIngredients.productionOrderId, productionOrderId),
                eq(productionOrderIngredients.materialId, materialId),
              ),
            );
          reversedIngredients += 1;
        }

        // Release any RM reservation still held for this production order's document.
        await tx.execute(sql`
          update inventory.stock_reservation
             set released_dt = now(), status = 'RELEASED', updated_by = ${principal.userId}
           where reserved_for_document_id = ${productionOrderId}
             and released_dt is null`);
      }

      await recordOutbox(
        tx,
        outbox,
        productionEvents.mixingSessionAborted,
        { secureMixingSessionId: sessionId, productionOrderId, reason: body.reason },
        sessionId,
      );

      return { session: updated, reversedIngredients };
    });
  }

  /* ── mixing step log (CRUD reads) ────────────────────────────────── */

  async listStepLogs(query: ListQuery): Promise<Page<typeof mixingStepLog.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(mixingStepLog)
      .where(query.cursor ? lt(mixingStepLog.mixingStepLogId, query.cursor) : undefined)
      .orderBy(desc(mixingStepLog.mixingStepLogId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.mixingStepLogId);
  }

  async getStepLog(id: string) {
    return (
      await this.db
        .select()
        .from(mixingStepLog)
        .where(eq(mixingStepLog.mixingStepLogId, id))
        .limit(1)
    )[0] ?? null;
  }
}
