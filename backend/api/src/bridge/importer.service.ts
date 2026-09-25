/**
 * ImporterService — the inbound half: ALEMBIC's ProductionRequirementCreated/
 * Changed/Cancelled land here. Three-step discipline (verify raw bytes → dedupe → decide)
 * matches ALEMBIC's own webhook handler and RawProd's own `RelayService.importPackage` —
 * the same ordering is the idempotency and security property on every side of every
 * channel in both codebases, so this is not a new convention, it is the existing one
 * applied to a third boundary.
 *
 * §24: before accepting, checks `payload.mapped_sku` against `packaging.product_sku` —
 * RawProd, not ALEMBIC, is the authority on whether the factory SKU exists. A miss emits
 * `ProductionRequirementRejectedMapping`, never a silent accept.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from './bridge.tokens.js';
import { openSecret } from './secret-box.js';
import { verifyBody } from './signing.js';
import {
  validateEnvelope, INBOUND_FROM_ALEMBIC, decideInbound, decideAcceptance,
  type LocalStatus, type BridgeEnvelope,
} from './contract.js';
import { convertQty } from './quantity.js';

const { productionRequirement, inboundEvent, connectorConfig, outbox } = bridgeSchema;

/** The transaction handle every apply step runs on (M4: one tx per inbound event). */
type Tx = Parameters<Parameters<BridgeDb['transaction']>[0]>[0];

export interface ImportResult {
  readonly status: number;
  readonly body: { readonly outcome: string; readonly detail?: string };
}

@Injectable()
export class ImporterService {
  constructor(
    @Inject(BRIDGE_DB) private readonly db: BridgeDb,
    @Inject(PG_CLIENT) private readonly sql: Sql,
  ) {}

  async handleAlembicEvent(rawBody: string, signatureHeader: string | null | undefined): Promise<ImportResult> {
    const config = (await this.db.select().from(connectorConfig)
      .where(eq(connectorConfig.id, 'default')).limit(1))[0];
    const secret = config?.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;

    // Fail closed: no configured/openable secret verifies nothing, ever.
    if (!secret || !verifyBody(rawBody, secret, signatureHeader)) {
      return { status: 401, body: { outcome: 'signature_invalid' } };
    }

    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch { return { status: 400, body: { outcome: 'bad_json' } }; }

    const v = validateEnvelope(parsed, INBOUND_FROM_ALEMBIC);
    if (!v.ok) return { status: 400, body: { outcome: 'bad_envelope', detail: v.problems.join(',') } };
    const env = v.envelope;

    // M4: dedupe-insert, decide, apply and mark-processed are ONE transaction. If the apply
    // throws, the inbound_event row rolls back with it, so ALEMBIC's retry of the same
    // event_id re-applies instead of being swallowed as `already_seen` with nothing applied.
    // A concurrent duplicate blocks on the PK insert until the first commits, then no-ops.
    return this.db.transaction(async (tx) => {
      const inserted = await tx.insert(inboundEvent).values({
        eventId: env.eventId, version: env.version, type: env.type,
        aggregateId: env.aggregate.id, correlationId: env.correlationId,
        causationId: env.causationId, occurredAt: new Date(env.occurredAt), payload: env.payload,
      }).onConflictDoNothing({ target: inboundEvent.eventId }).returning({ eventId: inboundEvent.eventId });

      if (inserted.length === 0) {
        return { status: 200, body: { outcome: 'already_seen' } };
      }

      const existing = (await tx.select().from(productionRequirement)
        .where(eq(productionRequirement.alembicRequirementId, env.aggregate.id)).limit(1).for('update'))[0];

      const decision = decideInbound({
        alreadyRecorded: false,
        incomingVersion: env.version,
        lastAppliedVersion: existing ? Number(existing.lastAppliedVersion) : 0,
        currentStatus: (existing?.lifecycleStatus as LocalStatus | undefined) ?? null,
        eventType: env.type,
      });

      if (decision.action === 'unknown_aggregate') {
        await this.park(tx, env.eventId, 'unknown_aggregate');
        return { status: 200, body: { outcome: 'parked_unknown_aggregate' } };
      }
      if (decision.action === 'park') {
        await this.park(tx, env.eventId, decision.parkedReason);
        return { status: 200, body: { outcome: 'parked_out_of_order' } };
      }

      if (env.type === 'ProductionRequirementCreated') {
        await this.applyCreated(tx, env);
      } else if (env.type === 'ProductionRequirementChanged') {
        await this.applyChanged(tx, env);
      } else if (env.type === 'ProductionRequirementCancelled') {
        await this.applyCancelled(tx, env);
      } else if (env.type === 'ProductionRequirementFulfilled') {
        await this.applyFulfilled(tx, env);
      }

      await tx.update(inboundEvent).set({ processedAt: new Date() })
        .where(eq(inboundEvent.eventId, env.eventId));

      return { status: 200, body: { outcome: 'applied' } };
    });
  }

  private async park(tx: Tx, eventId: string, reason: 'out_of_order' | 'unknown_aggregate'): Promise<void> {
    await tx.update(inboundEvent).set({ parkedReason: reason })
      .where(eq(inboundEvent.eventId, eventId));
  }

  private async skuExists(mappedSku: string): Promise<boolean> {
    const rows = await this.sql`
      select 1 from packaging.product_sku where sku_code = ${mappedSku} limit 1
    `;
    return rows.length > 0;
  }

  private async applyCreated(tx: Tx, env: BridgeEnvelope): Promise<void> {
    const p = env.payload;
    const mappedSku = String(p.mapped_sku ?? '');
    const exists = await this.skuExists(mappedSku);
    const ack = decideAcceptance(exists);

    await tx.insert(productionRequirement).values({
      alembicRequirementId: env.aggregate.id,
      orgId: env.orgId,
      correlationId: env.correlationId,
      orderRef: String(p.order_ref ?? ''),
      mappedSku,
      qty: String(p.qty ?? '0'),
      uom: String(p.uom ?? ''),
      packSize: p.pack_size ? String(p.pack_size) : null,
      neededBy: new Date(String(p.needed_by)),
      priority: String(p.priority ?? 'normal'),
      lifecycleStatus: exists ? 'ACCEPTED' : 'REJECTED_MAPPING',
      statusReason: exists ? null : 'mapped_sku not found in packaging.product_sku',
      lastAppliedVersion: '1',
      lastEmittedVersion: '1',
    });

    await tx.insert(outbox).values({
      type: ack,
      aggregateId: env.aggregate.id,
      payload: {
        requirement_id: env.aggregate.id, correlation_id: env.correlationId,
        // Read by relay.service.ts to set the outgoing envelope's `version`; stripped
        // from the payload actually sent to ALEMBIC (transport metadata, not domain data).
        _bridge_version: 1,
      },
    });
  }

  /** Atomically allocates the next outbound envelope version for `aggregateId` and
   *  returns it — the counter each RawProd->ALEMBIC event after the first Accepted
   *  must carry, per docs/bridge/EVENT_CONTRACT.md ordering. */
  private async nextEmittedVersion(tx: Tx, aggregateId: string): Promise<number> {
    const row = (await tx.update(productionRequirement)
      .set({ lastEmittedVersion: sql`${productionRequirement.lastEmittedVersion} + 1` })
      .where(eq(productionRequirement.alembicRequirementId, aggregateId))
      .returning({ v: productionRequirement.lastEmittedVersion }))[0];
    return row ? Number(row.v) : 1;
  }

  private async applyChanged(tx: Tx, env: BridgeEnvelope): Promise<void> {
    const p = env.payload;
    await tx.update(productionRequirement).set({
      mappedSku: p.mapped_sku ? String(p.mapped_sku) : undefined,
      qty: p.qty !== undefined ? String(p.qty) : undefined,
      uom: p.uom ? String(p.uom) : undefined,
      packSize: p.pack_size !== undefined ? String(p.pack_size) : undefined,
      neededBy: p.needed_by ? new Date(String(p.needed_by)) : undefined,
      priority: p.priority ? String(p.priority) : undefined,
      lastAppliedVersion: sql`${productionRequirement.lastAppliedVersion} + 1`,
    }).where(eq(productionRequirement.alembicRequirementId, env.aggregate.id));
  }

  private async applyCancelled(tx: Tx, env: BridgeEnvelope): Promise<void> {
    await tx.update(productionRequirement).set({
      lifecycleStatus: 'CANCELLED',
      statusReason: env.payload.reason ? String(env.payload.reason) : 'cancelled by ALEMBIC',
      lastAppliedVersion: sql`${productionRequirement.lastAppliedVersion} + 1`,
    }).where(eq(productionRequirement.alembicRequirementId, env.aggregate.id));

    const version = await this.nextEmittedVersion(tx, env.aggregate.id);
    await tx.insert(outbox).values({
      type: 'ProductionRequirementCancelledAck',
      aggregateId: env.aggregate.id,
      payload: { requirement_id: env.aggregate.id, correlation_id: env.correlationId, _bridge_version: version },
    });
  }

  /**
   * Golden-journey gap 3 — ALEMBIC's goods receipt of the factory FG is the physical
   * hand-over for a bridge requirement, so it (not RawProd's sales `Dispatched`) closes the
   * requirement. Runs inside the caller's per-event transaction (M4).
   *
   * M3 (security review): only `received_qty` is consumed — never the whole reservation.
   *   1. FG hand-over: the event's received_qty is allocated across still-ACTIVE
   *      finished_good_reservation rows for the linked production order (oldest first). A
   *      reservation fully covered becomes HANDED_OVER (released_dt stamped); a partially
   *      covered one has its reserved_qty reduced and stays ACTIVE (the remainder stays
   *      reserved). Each allocation writes an equal finished_goods_batch_consumption row.
   *   2. Partial receipts accumulate: the cumulative received qty is the sum over this
   *      aggregate's applied (non-parked) Fulfilled inbound_event rows — the event_id PK is the
   *      idempotency key, so replaying the same event is `already_seen` and never re-consumes.
   *      The requirement goes COMPLETE (terminal) and ProductionRequirementCompleted is emitted
   *      only once cumulative received >= requirement qty; otherwise it stays in its current
   *      status (so the next Fulfilled version still applies) with a partial status_reason.
   */
  private async applyFulfilled(tx: Tx, env: BridgeEnvelope): Promise<void> {
    const p = env.payload;
    const receiptRef = String(p.receipt_ref ?? '');
    const receivedRaw = Number(p.received_qty);
    const receivedQty = Number.isFinite(receivedRaw) && receivedRaw > 0 ? receivedRaw : 0;
    const uom = String(p.uom ?? '');
    const orderRef = String(p.order_ref ?? '');
    const aggregateId = env.aggregate.id;

    const req = (await tx.select().from(productionRequirement)
      .where(eq(productionRequirement.alembicRequirementId, aggregateId)).limit(1).for('update'))[0];
    const productionOrderId = req?.productionOrderId ?? null;

    let handedOver = 0;
    let consumed = 0;
    if (productionOrderId && receivedQty > 0) {
      const reservations = (await tx.execute(sql`
        select r.finished_good_reservation_id as id, r.finished_good_batch_id as fg_id,
               r.reserved_qty::numeric as qty, r.uom_id
          from packaging.finished_good_reservation r
          join packaging.finished_good_batch_master fg on fg.finished_good_batch_id = r.finished_good_batch_id
          join packaging.package_order po on po.package_order_id = fg.package_order_id
          join production.oil_batch_master ob on ob.oil_batch_id = po.oil_batch_id
         where ob.production_order_id = ${productionOrderId}
           and r.released_dt is null and coalesce(r.status, 'ACTIVE') = 'ACTIVE'
         order by r.created_dt, r.finished_good_reservation_id
         for update of r
      `)) as unknown as Array<{ id: string; fg_id: string; qty: string; uom_id: string | null }>;

      let remaining = receivedQty;
      for (const r of reservations) {
        if (remaining <= 0) break;
        const reserved = Number(r.qty);
        if (!(reserved > 0)) continue;
        const take = Math.min(remaining, reserved);
        if (take >= reserved) {
          await tx.execute(sql`
            update packaging.finished_good_reservation
               set status = 'HANDED_OVER', released_dt = now(), updated_dt = now(), updated_by = 'bridge:alembic'
             where finished_good_reservation_id = ${r.id}`);
          handedOver += 1;
        } else {
          await tx.execute(sql`
            update packaging.finished_good_reservation
               set reserved_qty = reserved_qty - ${take}, updated_dt = now(), updated_by = 'bridge:alembic'
             where finished_good_reservation_id = ${r.id}`);
        }
        await tx.execute(sql`
          insert into packaging.finished_goods_batch_consumption
            (finished_goods_batch_consumption_id, finished_good_batch_id, consumed_for_document_id,
             consumed_qty, uom_id, consumed_dt, status, created_by, updated_by)
          values (gen_random_uuid(), ${r.fg_id}, ${aggregateId}::uuid, ${take}, ${r.uom_id}, now(),
                  'ACTIVE', 'bridge:alembic', 'bridge:alembic')`);
        consumed += take;
        remaining -= take;
      }
    }

    // Cumulative received across every applied Fulfilled for this aggregate, INCLUDING this
    // event (its inbound_event row was inserted earlier in this same transaction), each one
    // converted into the REQUIREMENT's unit (ALEMBIC raises in mg, receives in kg).
    const requiredUom = String(req?.uom ?? '');
    const receipts = (await tx.execute(sql`
      select payload->>'received_qty' as qty, payload->>'uom' as uom
        from bridge.inbound_event
       where aggregate_id = ${aggregateId}::uuid and type = 'ProductionRequirementFulfilled'
         and parked_reason is null
    `)) as unknown as Array<{ qty: string | null; uom: string | null }>;
    let cumulative = 0;
    let unconvertible: string | null = null;
    for (const r of receipts) {
      const q = /^[0-9]+([.][0-9]+)?$/.test(String(r.qty ?? '')) ? Number(r.qty) : 0;
      const inReqUnits = convertQty(q, String(r.uom ?? requiredUom), requiredUom);
      if (inReqUnits === null) { unconvertible = String(r.uom ?? ''); continue; }
      cumulative += inReqUnits;
    }
    const required = Number(req?.qty ?? 0);
    const complete = unconvertible === null && cumulative >= required;

    const fgNote = !productionOrderId
      ? 'no linked production order; no FG reservation to hand over'
      : consumed > 0
        ? `${consumed} consumed from FG reservation(s), ${handedOver} fully HANDED_OVER`
        : 'no active FG reservation for the linked production order';
    const statusReason = `${complete ? 'fulfilled' : 'partially fulfilled'}: ALEMBIC goods receipt ${receiptRef || '(no ref)'}`
      + ` received ${String(p.received_qty ?? '')} ${uom}`.trimEnd()
      + ` (cumulative ${cumulative} of ${required} ${requiredUom}); ${fgNote}`
      + (unconvertible === null ? '' : `; receipt unit '${unconvertible}' cannot be converted to '${requiredUom}'`);

    if (!complete) {
      await tx.update(productionRequirement).set({
        statusReason,
        lastAppliedVersion: sql`${productionRequirement.lastAppliedVersion} + 1`,
        updatedDt: new Date(),
      }).where(eq(productionRequirement.alembicRequirementId, aggregateId));
      return;
    }

    const bumped = (await tx.update(productionRequirement).set({
      lifecycleStatus: 'COMPLETE',
      statusReason,
      lastAppliedVersion: sql`${productionRequirement.lastAppliedVersion} + 1`,
      lastEmittedVersion: sql`${productionRequirement.lastEmittedVersion} + 1`,
      updatedDt: new Date(),
    }).where(eq(productionRequirement.alembicRequirementId, aggregateId))
      .returning({ v: productionRequirement.lastEmittedVersion }))[0];

    await tx.insert(outbox).values({
      type: 'ProductionRequirementCompleted',
      aggregateId,
      payload: {
        requirement_id: aggregateId, correlation_id: env.correlationId,
        order_ref: orderRef || req?.orderRef || '', receipt_ref: receiptRef,
        _bridge_version: bumped ? Number(bumped.v) : 1,
      },
    });
  }
}
