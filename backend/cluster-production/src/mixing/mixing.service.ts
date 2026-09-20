/**
 * MixingService — secure mixing: SECURE_MIXING_SESSION, MIXING_STEP_LOG. CRUD reads for both,
 * plus the session flow:
 *
 *   startSession → open an IN_PROGRESS session against a production order.
 *   logStep      → append a mixing_step_log row to a session.
 *   endSession   → set session_end_dt and flip status to COMPLETED.
 *
 * Pre-generated ids use uuidv7(); created_by/updated_by = principal.userId; ISO timestamps →
 * Date. order/operator/stage/user refs are id-only soft refs (plain uuid, no FK at this layer).
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { paginate, type Page } from '../_helpers.js';
import type {
  CreateMixingSession,
  EndMixingSession,
  ListQuery,
  LogStep,
} from '../production.dtos.js';

const { secureMixingSession, mixingStepLog } = productionSchema;

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

  /** POST /v1/mixing-sessions/:id/end — set session_end_dt + status COMPLETED. */
  async endSession(sessionId: string, body: EndMixingSession, principal: AuthPrincipal) {
    const session = await this.getSession(sessionId);
    if (!session) throw new NotFoundException(`secure_mixing_session not found: ${sessionId}`);

    const row = (
      await this.db
        .update(secureMixingSession)
        .set({
          sessionEndDt: body.sessionEndDt ? new Date(body.sessionEndDt) : new Date(),
          status: 'COMPLETED',
          updatedBy: principal.userId,
        })
        .where(eq(secureMixingSession.secureMixingSessionId, sessionId))
        .returning()
    )[0];
    if (!row) throw new Error('update failed: secure_mixing_session');
    return row;
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
