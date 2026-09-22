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
 *                  was already issued for this session's production order — credits back
 *                  inventory.inventory_batch.quantity_on_hand for every ingredient the picking
 *                  flow (PickingService.issueMaterials) had flagged issued, resets those
 *                  production_order_ingredients.issued_qty back to false, marks the reversed
 *                  material_issue_item rows REVERSED, and releases any open RM stock_reservation
 *                  held against this production order — all inside ONE transaction with the
 *                  mixing_step_log ABORT row, so the reversal is never partially applied.
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; ISO timestamps →
 * Date. order/operator/stage/user refs are id-only soft refs (plain uuid, no FK at this layer).
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
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

  /** POST /v1/mixing-sessions — open a session. */
  async startSession(body: CreateMixingSession, principal: AuthPrincipal) {
    const row = (
      await this.db
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
    return row;
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
   * mixing_step_log row, reverses any materials already issued against the session's production
   * order (credits inventory.inventory_batch.quantity_on_hand back, resets
   * production_order_ingredients.issued_qty, marks the material_issue_item rows REVERSED), and
   * releases any still-open inventory.stock_reservation held for that production order. One
   * transaction: the abort, the audit row, and every reversal commit or roll back together.
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
        // Reverse whatever PickingService.issueMaterials already flagged issued for this order:
        // credit the batch on-hand back, un-flag the ingredient, mark the issue item REVERSED.
        const issuedIngredients = await tx
          .select()
          .from(productionOrderIngredients)
          .where(
            and(
              eq(productionOrderIngredients.productionOrderId, productionOrderId),
              eq(productionOrderIngredients.issuedQty, true),
            ),
          );

        for (const ing of issuedIngredients) {
          if (!ing.materialId) continue;
          const materialId = ing.materialId;
          const items = (await tx.execute(sql`
            select mii.material_issue_item_id, mii.inventory_batch_id
              from production.material_issue_item mii
              join production.material_issue mi on mi.material_issue_id = mii.material_issue_id
             where mi.production_order_id = ${productionOrderId}
               and mii.material_id = ${materialId}
               and mii.issued_qty = true
               and coalesce(mii.status, 'ACTIVE') <> 'REVERSED'`)) as unknown as Array<{
            material_issue_item_id: string;
            inventory_batch_id: string | null;
          }>;

          for (const item of items) {
            if (item.inventory_batch_id && ing.requiredQty != null) {
              await tx.execute(sql`
                update inventory.inventory_batch
                   set quantity_on_hand = coalesce(quantity_on_hand, 0) + ${Number(ing.requiredQty)}
                 where inventory_batch_id = ${item.inventory_batch_id}`);
            }
            await tx.execute(sql`
              update production.material_issue_item
                 set status = 'REVERSED', updated_by = ${principal.userId}
               where material_issue_item_id = ${item.material_issue_item_id}`);
          }

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
