/**
 * CapaService — QC_CAPA + the closure/verification workflow (RP-FAC2 / RP-QC-002: this used to be
 * table-only CRUD — no workflow, no closure/verification step, so a CAPA could be inserted already
 * "closed" and never actually gated inventory or QC decisions). Guarded state machine, same CAS
 * pattern as the oil-batch transition (BatchService.transitionOilBatch):
 *
 *   OPEN → IN_PROGRESS → CLOSED → VERIFIED
 *
 * startCapa requires an action plan to exist before work can start; closeCapa requires closure
 * evidence; verifyCapa enforces segregation of duties (the CAPA's creator and its assignee — the
 * people who raised/executed it — cannot also be the one who verifies it closed). Every move is a
 * compare-and-swap (`UPDATE ... WHERE status = :current`) so two concurrent transitions off the
 * same state can't both win.
 */
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { uuidv7 } from '@core/data-kernel';
import type { AuthPrincipal } from '@core/backend-kernel';
import { QUALITY_DB, qualitySchema, type QualityDb } from '../quality.tokens.js';
import type { CloseCapa, CreateQcCapa, ListQuery, VerifyCapa } from '../quality.dtos.js';

const { qcCapa } = qualitySchema;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class CapaService {
  constructor(@Inject(QUALITY_DB) private readonly db: QualityDb) {}

  async createCapa(body: CreateQcCapa, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(qcCapa)
        .values({
          qcCapaId: uuidv7(),
          qcInspectionId: body.qcInspectionId ?? null,
          capaCode: body.capaCode,
          capaType: body.capaType ?? null,
          description: body.description ?? null,
          rootCause: body.rootCause ?? null,
          actionPlan: body.actionPlan ?? null,
          assignedTo: body.assignedTo ?? null,
          dueDt: body.dueDt ? new Date(body.dueDt) : null,
          status: 'OPEN',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: qc_capa');
    return row;
  }

  /* ── flow: OPEN → IN_PROGRESS ─────────────────────────────────────── */

  /** POST /v1/qc-capas/:id/start — work begins; requires an action plan to already be recorded. */
  async startCapa(id: string, principal: AuthPrincipal) {
    const capa = await this.getCapa(id);
    if (!capa) throw new NotFoundException(`qc_capa not found: ${id}`);
    const current = String(capa.status ?? 'OPEN').toUpperCase();
    if (current !== 'OPEN') {
      throw new ConflictException(`CAPA cannot be started from status ${current} (must be OPEN).`);
    }
    if (!capa.actionPlan || !String(capa.actionPlan).trim()) {
      throw new ConflictException('CAPA cannot be started: no action plan has been recorded.');
    }
    const updated = (
      await this.db
        .update(qcCapa)
        .set({ status: 'IN_PROGRESS', updatedBy: principal.userId })
        .where(and(eq(qcCapa.qcCapaId, id), eq(qcCapa.status, 'OPEN')))
        .returning()
    )[0];
    if (!updated) {
      throw new ConflictException(`CAPA ${id} was moved off OPEN by a concurrent request; refusing this stale start.`);
    }
    return updated;
  }

  /* ── flow: IN_PROGRESS → CLOSED ───────────────────────────────────── */

  /** POST /v1/qc-capas/:id/close — requires closure evidence; stamps closed_dt. */
  async closeCapa(id: string, body: CloseCapa, principal: AuthPrincipal) {
    const capa = await this.getCapa(id);
    if (!capa) throw new NotFoundException(`qc_capa not found: ${id}`);
    const current = String(capa.status ?? 'OPEN').toUpperCase();
    if (current !== 'IN_PROGRESS') {
      throw new ConflictException(`CAPA cannot be closed from status ${current} (must be IN_PROGRESS).`);
    }
    const updated = (
      await this.db
        .update(qcCapa)
        .set({
          status: 'CLOSED',
          closedDt: new Date(),
          closureEvidence: body.closureEvidence,
          updatedBy: principal.userId,
        })
        .where(and(eq(qcCapa.qcCapaId, id), eq(qcCapa.status, 'IN_PROGRESS')))
        .returning()
    )[0];
    if (!updated) {
      throw new ConflictException(`CAPA ${id} was moved off IN_PROGRESS by a concurrent request; refusing this stale close.`);
    }
    return updated;
  }

  /* ── flow: CLOSED → VERIFIED ──────────────────────────────────────── */

  /**
   * POST /v1/qc-capas/:id/verify — segregation of duties: neither the CAPA's creator (who raised
   * it) nor its assignee (who executed the corrective action) may also verify its closure.
   * verified_by is always the authenticated caller, never a spoofable body field.
   */
  async verifyCapa(id: string, _body: VerifyCapa, principal: AuthPrincipal) {
    const capa = await this.getCapa(id);
    if (!capa) throw new NotFoundException(`qc_capa not found: ${id}`);
    const current = String(capa.status ?? 'OPEN').toUpperCase();
    if (current !== 'CLOSED') {
      throw new ConflictException(`CAPA cannot be verified from status ${current} (must be CLOSED).`);
    }
    if (capa.createdBy && capa.createdBy === principal.userId) {
      throw new ForbiddenException('Segregation of duties: you raised this CAPA, so you cannot verify its closure.');
    }
    if (capa.assignedTo && capa.assignedTo === principal.userId) {
      throw new ForbiddenException('Segregation of duties: you were assigned this CAPA, so you cannot verify your own closure.');
    }
    const updated = (
      await this.db
        .update(qcCapa)
        .set({ status: 'VERIFIED', verifiedBy: principal.userId, verifiedDt: new Date(), updatedBy: principal.userId })
        .where(and(eq(qcCapa.qcCapaId, id), eq(qcCapa.status, 'CLOSED')))
        .returning()
    )[0];
    if (!updated) {
      throw new ConflictException(`CAPA ${id} was moved off CLOSED by a concurrent request; refusing this stale verification.`);
    }
    return updated;
  }

  async listCapas(query: ListQuery): Promise<Page<typeof qcCapa.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(qcCapa)
      .where(query.cursor ? lt(qcCapa.qcCapaId, query.cursor) : undefined)
      .orderBy(desc(qcCapa.qcCapaId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.qcCapaId);
  }

  async getCapa(id: string) {
    return (await this.db.select().from(qcCapa).where(eq(qcCapa.qcCapaId, id)).limit(1))[0] ?? null;
  }
}

/** Shared cursor pagination — desc(pk), limit+1 → {items, nextCursor}. */
export function paginate<T>(rows: T[], limit: number, pk: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? pk(last) : null;
  return { items, nextCursor };
}
