/**
 * OutboxAdminService — the operator's side of the bridge dead-letter list (OPS_GREEN §17, P1),
 * RawProd → ALEMBIC direction. The mirror of ALEMBIC's GET /api/v1/bridge/outbound/parked and
 * its replay/discard.
 *
 *   list     every outbox event the relay parked and nobody has replayed or discarded, oldest
 *            first, WITHOUT its payload (type, reason and ALEMBIC's answer are what an
 *            operator acts on).
 *   replay   back into the queue, due now, with a fresh retry budget. The same event id goes
 *            out again; ALEMBIC's inbox dedupes on it, so a copy that did land is a harmless
 *            `already_seen`.
 *   discard  out of the queue for good, with who and why. The rows stay, as the record of an
 *            event ALEMBIC never received.
 *
 * Both writes are state transitions guarded on "parked, not discarded, not published", so a
 * repeat is a no-op answered 409 rather than a second effect, and both are audited in
 * `bridge.audit_events` in the same transaction as the change.
 */
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from './bridge.tokens.js';

const { auditEvents } = bridgeSchema;

export interface ParkedOutboxRow {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string | null;
  readonly occurredAt: string;
  readonly attempts: number;
  readonly parkedAt: string;
  readonly parkedReason: 'permanent' | 'max_attempts';
  readonly lastError: string | null;
  readonly lastHttpStatus: number | null;
}

interface Raw {
  id: string; type: string; aggregate_id: string | null; occurred_at: Date | string;
  attempts: number; parked_at: Date | string; parked_reason: 'permanent' | 'max_attempts';
  last_error: string | null; last_http_status: number | null;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v));
const map = (r: Raw): ParkedOutboxRow => ({
  id: r.id, type: r.type, aggregateId: r.aggregate_id, occurredAt: iso(r.occurred_at),
  attempts: Number(r.attempts), parkedAt: iso(r.parked_at), parkedReason: r.parked_reason,
  lastError: r.last_error, lastHttpStatus: r.last_http_status === null ? null : Number(r.last_http_status),
});

const NOT_PARKED = 'that event is not in the dead-letter list (already delivered, discarded, replayed, or never parked)';

@Injectable()
export class OutboxAdminService {
  constructor(@Inject(BRIDGE_DB) private readonly db: BridgeDb) {}

  async listParked(limit = 200): Promise<{ items: ParkedOutboxRow[] }> {
    const n = Math.min(Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 200)), 500);
    const rows = (await this.db.execute(sql`
      select o.id, o.type, o.aggregate_id, o.occurred_at, d.attempts, d.parked_at, d.parked_reason,
             d.last_error, d.last_http_status
        from bridge.outbox_delivery d
        join bridge.outbox o on o.id = d.outbox_id
       where d.parked_at is not null and d.discarded_at is null and o.published_at is null
       order by d.parked_at, o.seq
       limit ${n}
    `)) as unknown as Raw[];
    return { items: rows.map(map) };
  }

  async replay(id: string, actorId: string): Promise<{ id: string; replayed: true; prior: ParkedOutboxRow }> {
    return this.db.transaction(async (tx) => {
      const prior = (await tx.execute(sql`
        select o.id, o.type, o.aggregate_id, o.occurred_at, d.attempts, d.parked_at, d.parked_reason,
               d.last_error, d.last_http_status
          from bridge.outbox_delivery d
          join bridge.outbox o on o.id = d.outbox_id
         where d.outbox_id = ${id}::uuid and d.parked_at is not null and d.discarded_at is null
           and o.published_at is null
         for update of d
      `)) as unknown as Raw[];
      const row = prior[0];
      if (!row) throw new ConflictException(`not replayed: ${NOT_PARKED}`);
      await tx.execute(sql`
        update bridge.outbox_delivery
           set parked_at = null, parked_reason = null, attempts = 0, next_attempt_at = now(), updated_at = now()
         where outbox_id = ${id}::uuid
      `);
      const p = map(row);
      await tx.insert(auditEvents).values({
        actorId, action: 'bridge.outbox_replayed', entityType: 'bridge_outbox', entityId: id,
        before: { parkedReason: p.parkedReason, attempts: p.attempts, lastError: p.lastError, lastHttpStatus: p.lastHttpStatus },
        after: { type: p.type, aggregateId: p.aggregateId },
        occurredAt: new Date(),
      });
      return { id, replayed: true as const, prior: p };
    });
  }

  async discard(id: string, actorId: string, reason: string): Promise<{ id: string; discarded: true; reason: string }> {
    return this.db.transaction(async (tx) => {
      const prior = (await tx.execute(sql`
        update bridge.outbox_delivery d
           set discarded_at = now(), discarded_by = ${actorId}, discard_reason = ${reason}, updated_at = now()
          from bridge.outbox o
         where d.outbox_id = ${id}::uuid and o.id = d.outbox_id and d.parked_at is not null
           and d.discarded_at is null and o.published_at is null
        returning o.id, o.type, o.aggregate_id, o.occurred_at, d.attempts, d.parked_at, d.parked_reason,
                  d.last_error, d.last_http_status
      `)) as unknown as Raw[];
      const row = prior[0];
      if (!row) throw new ConflictException(`not discarded: ${NOT_PARKED}`);
      const p = map(row);
      await tx.insert(auditEvents).values({
        actorId, action: 'bridge.outbox_discarded', entityType: 'bridge_outbox', entityId: id,
        before: { parkedReason: p.parkedReason, attempts: p.attempts, lastError: p.lastError, lastHttpStatus: p.lastHttpStatus },
        after: { type: p.type, aggregateId: p.aggregateId, reason },
        occurredAt: new Date(),
      });
      return { id, discarded: true as const, reason };
    });
  }
}
