/**
 * WeighingService (OPS-GREEN Act L, lane ops-factory) — the WEIGH step between material issue and
 * mixing. The operator places each coded-instruction line on a balance and records gross and tare;
 * the server resolves that line's target from the Vault (the same `VAULT_PORT` read
 * `GET /v1/production-orders/:id/manufacturing-instruction` uses: floor code + quantity, never the
 * material) and decides whether the net is within tolerance. The operator never types the target
 * and never sees a material identity.
 *
 *   recordWeighing  → one production.weighing_record row, ACCEPTED (|net − target| ≤ target ×
 *                     tolerance) or OUT_OF_TOLERANCE (kept on file; the operator re-weighs). One
 *                     ACCEPTED row per (session, line): a second is 409. Emits
 *                     production.weighing.recorded in the same transaction.
 *   unweighedLineCount → the instruction lines of a session's order that still have no ACCEPTED
 *                     reading; MixingService.endSession refuses to complete a session while any
 *                     remain.
 *
 * Tolerance is plant policy, `WEIGHING_TOLERANCE_PCT` (default 1 %), never a request field.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { VAULT_PORT, type VaultPort } from '@ra/cluster-formula';
import { PRODUCTION_DB, productionSchema, type ProductionDb } from '../production.tokens.js';
import { productionEvents } from '../production.events.js';
import { paginate, type Page } from '../_helpers.js';
import type { ListQuery, RecordWeighing } from '../production.dtos.js';

const { secureMixingSession, productionOrder, productionOrderIngredients, weighingRecord, outbox } = productionSchema;

export function weighingTolerancePct(): number {
  const v = Number(process.env.WEIGHING_TOLERANCE_PCT);
  return Number.isFinite(v) && v >= 0 && v <= 10 ? v : 1;
}

/** Pure: is `net` within `tolerancePct` % of `target`? Rounded to the column's 4 decimals. */
export function withinTolerance(net: number, target: number, tolerancePct: number): boolean {
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  return round(Math.abs(net - target)) <= round((Math.abs(target) * tolerancePct) / 100);
}

/** Instruction lines of `productionOrderId` still lacking an ACCEPTED reading in `sessionId`.
 *  The order's expanded ingredient rows are one per instruction line (PlanningService.createOrder
 *  expands one per pick), so counting needs no Vault round trip. Used by MixingService.endSession. */
export async function unweighedLineCount(db: ProductionDb, sessionId: string, productionOrderId: string): Promise<number> {
  const ingredients = await db.select({ id: productionOrderIngredients.productionOrderIngredientId })
    .from(productionOrderIngredients).where(eq(productionOrderIngredients.productionOrderId, productionOrderId));
  if (ingredients.length === 0) return 0;
  const accepted = await db.selectDistinct({ seq: weighingRecord.sequenceNo }).from(weighingRecord)
    .where(and(eq(weighingRecord.secureMixingSessionId, sessionId), eq(weighingRecord.status, 'ACCEPTED')));
  return Math.max(0, ingredients.length - accepted.length);
}

@Injectable()
export class WeighingService {
  constructor(
    @Inject(PRODUCTION_DB) private readonly db: ProductionDb,
    @Inject(VAULT_PORT) private readonly vault: VaultPort,
  ) {}

  async recordWeighing(sessionId: string, body: RecordWeighing, principal: AuthPrincipal) {
    const session = (await this.db.select().from(secureMixingSession)
      .where(eq(secureMixingSession.secureMixingSessionId, sessionId)).limit(1))[0];
    if (!session) throw new NotFoundException(`secure_mixing_session not found: ${sessionId}`);
    if (String(session.status ?? '').toUpperCase() !== 'IN_PROGRESS') {
      throw new ConflictException(`Weighing is recorded only on an IN_PROGRESS mixing session (this one is ${session.status}).`);
    }
    const orderId = session.productionOrderId;
    if (!orderId) throw new ConflictException(`Mixing session ${sessionId} is not linked to a production order.`);
    const order = (await this.db.select().from(productionOrder)
      .where(eq(productionOrder.productionOrderId, orderId)).limit(1))[0];
    if (!order?.formulaVersionId) throw new ConflictException(`Production order ${orderId} has no formula version to weigh against.`);

    const lines = await this.vault.resolveManufacturingInstruction(order.formulaVersionId, Number(order.orderQty ?? 0), {
      actorId: principal.userId, requestId: `weighing:${sessionId}`,
    });
    const line = (lines ?? []).find((l) => Number(l.sequenceNo) === body.sequenceNo);
    if (!line) throw new BadRequestException(`The coded instruction for this order has no line ${body.sequenceNo}.`);
    const floorCode = line.code;
    if (!floorCode) throw new ConflictException(`Instruction line ${body.sequenceNo} has no floor code; master data must give it an RM alias first.`);

    const net = Math.round((body.grossQty - body.tareQty) * 10_000) / 10_000;
    if (!(net > 0)) throw new BadRequestException('Net weight (gross − tare) must be positive.');
    const target = Number(line.quantity);
    const tolerance = weighingTolerancePct();
    const ok = withinTolerance(net, target, tolerance);

    return this.db.transaction(async (tx) => {
      if (ok) {
        const already = await tx.select({ id: weighingRecord.weighingRecordId }).from(weighingRecord)
          .where(and(eq(weighingRecord.secureMixingSessionId, sessionId), eq(weighingRecord.sequenceNo, body.sequenceNo),
            eq(weighingRecord.status, 'ACCEPTED'))).limit(1);
        if (already.length > 0) throw new ConflictException(`Instruction line ${body.sequenceNo} is already weighed and accepted for this session.`);
      }
      const row = (await tx.insert(weighingRecord).values({
        weighingRecordId: uuidv7(),
        productionOrderId: orderId,
        secureMixingSessionId: sessionId,
        sequenceNo: body.sequenceNo,
        floorCode,
        targetQty: String(target),
        uom: line.uom ?? null,
        grossQty: String(body.grossQty),
        tareQty: String(body.tareQty),
        netQty: String(net),
        tolerancePct: String(tolerance),
        withinTolerance: ok,
        scaleRef: body.scaleRef ?? null,
        weighedBy: principal.userId,
        weighedDt: new Date(),
        status: ok ? 'ACCEPTED' : 'OUT_OF_TOLERANCE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      }).returning())[0];
      if (!row) throw new Error('insert failed: weighing_record');
      await recordOutbox(tx, outbox, productionEvents.weighingRecorded, {
        weighingRecordId: row.weighingRecordId, secureMixingSessionId: sessionId,
        productionOrderId: orderId, sequenceNo: body.sequenceNo, withinTolerance: ok,
      }, row.weighingRecordId);
      return row;
    });
  }

  async list(query: ListQuery & { sessionId?: string }): Promise<Page<typeof weighingRecord.$inferSelect>> {
    const rows = await this.db.select().from(weighingRecord)
      .where(and(
        query.cursor ? lt(weighingRecord.weighingRecordId, query.cursor) : undefined,
        query.sessionId ? eq(weighingRecord.secureMixingSessionId, query.sessionId) : undefined,
      ))
      .orderBy(desc(weighingRecord.weighingRecordId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.weighingRecordId);
  }

  async get(id: string) {
    return (await this.db.select().from(weighingRecord).where(eq(weighingRecord.weighingRecordId, id)).limit(1))[0] ?? null;
  }
}
