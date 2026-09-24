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

const { productionRequirement, inboundEvent, connectorConfig, outbox } = bridgeSchema;

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

    // Dedupe first, inside the same statement the whole handler runs in.
    const inserted = await this.db.insert(inboundEvent).values({
      eventId: env.eventId, version: env.version, type: env.type,
      aggregateId: env.aggregate.id, correlationId: env.correlationId,
      causationId: env.causationId, occurredAt: new Date(env.occurredAt), payload: env.payload,
    }).onConflictDoNothing({ target: inboundEvent.eventId }).returning({ eventId: inboundEvent.eventId });

    if (inserted.length === 0) {
      return { status: 200, body: { outcome: 'already_seen' } };
    }

    const existing = (await this.db.select().from(productionRequirement)
      .where(eq(productionRequirement.alembicRequirementId, env.aggregate.id)).limit(1))[0];

    const decision = decideInbound({
      alreadyRecorded: false,
      incomingVersion: env.version,
      lastAppliedVersion: existing ? Number(existing.lastAppliedVersion) : 0,
      currentStatus: (existing?.lifecycleStatus as LocalStatus | undefined) ?? null,
      eventType: env.type,
    });

    if (decision.action === 'unknown_aggregate') {
      await this.park(env.eventId, 'unknown_aggregate');
      return { status: 200, body: { outcome: 'parked_unknown_aggregate' } };
    }
    if (decision.action === 'park') {
      await this.park(env.eventId, decision.parkedReason);
      return { status: 200, body: { outcome: 'parked_out_of_order' } };
    }

    if (env.type === 'ProductionRequirementCreated') {
      await this.applyCreated(env);
    } else if (env.type === 'ProductionRequirementChanged') {
      await this.applyChanged(env);
    } else if (env.type === 'ProductionRequirementCancelled') {
      await this.applyCancelled(env);
    } else if (env.type === 'ProductionRequirementFulfilled') {
      await this.applyFulfilled(env);
    }

    await this.db.update(inboundEvent).set({ processedAt: new Date() })
      .where(eq(inboundEvent.eventId, env.eventId));

    return { status: 200, body: { outcome: 'applied' } };
  }

  private async park(eventId: string, reason: 'out_of_order' | 'unknown_aggregate'): Promise<void> {
    await this.db.update(inboundEvent).set({ parkedReason: reason })
      .where(eq(inboundEvent.eventId, eventId));
  }

  private async skuExists(mappedSku: string): Promise<boolean> {
    const rows = await this.sql`
      select 1 from packaging.product_sku where sku_code = ${mappedSku} limit 1
    `;
    return rows.length > 0;
  }

  private async applyCreated(env: BridgeEnvelope): Promise<void> {
    const p = env.payload;
    const mappedSku = String(p.mapped_sku ?? '');
    const exists = await this.skuExists(mappedSku);
    const ack = decideAcceptance(exists);

    await this.db.insert(productionRequirement).values({
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

    await this.db.insert(outbox).values({
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
  private async nextEmittedVersion(aggregateId: string): Promise<number> {
    const row = (await this.db.update(productionRequirement)
      .set({ lastEmittedVersion: sql`${productionRequirement.lastEmittedVersion} + 1` })
      .where(eq(productionRequirement.alembicRequirementId, aggregateId))
      .returning({ v: productionRequirement.lastEmittedVersion }))[0];
    return row ? Number(row.v) : 1;
  }

  private async applyChanged(env: BridgeEnvelope): Promise<void> {
    const p = env.payload;
    await this.db.update(productionRequirement).set({
      mappedSku: p.mapped_sku ? String(p.mapped_sku) : undefined,
      qty: p.qty !== undefined ? String(p.qty) : undefined,
      uom: p.uom ? String(p.uom) : undefined,
      packSize: p.pack_size !== undefined ? String(p.pack_size) : undefined,
      neededBy: p.needed_by ? new Date(String(p.needed_by)) : undefined,
      priority: p.priority ? String(p.priority) : undefined,
      lastAppliedVersion: sql`${productionRequirement.lastAppliedVersion} + 1`,
    }).where(eq(productionRequirement.alembicRequirementId, env.aggregate.id));
  }

  private async applyCancelled(env: BridgeEnvelope): Promise<void> {
    await this.db.update(productionRequirement).set({
      lifecycleStatus: 'CANCELLED',
      statusReason: env.payload.reason ? String(env.payload.reason) : 'cancelled by ALEMBIC',
      lastAppliedVersion: sql`${productionRequirement.lastAppliedVersion} + 1`,
    }).where(eq(productionRequirement.alembicRequirementId, env.aggregate.id));

    const version = await this.nextEmittedVersion(env.aggregate.id);
    await this.db.insert(outbox).values({
      type: 'ProductionRequirementCancelledAck',
      aggregateId: env.aggregate.id,
      payload: { requirement_id: env.aggregate.id, correlation_id: env.correlationId, _bridge_version: version },
    });
  }

  /**
   * Golden-journey gap 3 — ALEMBIC's goods receipt of the factory FG is the physical
   * hand-over for a bridge requirement, so it (not RawProd's sales `Dispatched`, which needs
   * a sales order a bridge requirement never gets) closes the requirement. One transaction:
   *   1. requirement -> COMPLETE (terminal in decideInbound), lastAppliedVersion + 1;
   *   2. FG hand-over: every still-ACTIVE finished_good_reservation on an FG batch produced
   *      for the linked production order (fg -> package_order -> oil_batch -> production_order)
   *      becomes HANDED_OVER (released_dt stamped) and an equal finished_goods_batch_consumption
   *      row (consumed_for_document_id = requirement id) is written, so ATP moves the qty from
   *      "reserved" to "consumed" instead of freeing it. Only ACTIVE rows are touched, so it
   *      is idempotent. No linked order / no reservation -> recorded in status_reason;
   *   3. outbox ProductionRequirementCompleted at the next emitted version.
   */
  private async applyFulfilled(env: BridgeEnvelope): Promise<void> {
    const p = env.payload;
    const receiptRef = String(p.receipt_ref ?? '');
    const receivedQty = String(p.received_qty ?? '');
    const uom = String(p.uom ?? '');
    const orderRef = String(p.order_ref ?? '');
    const aggregateId = env.aggregate.id;

    await this.db.transaction(async (tx) => {
      const req = (await tx.select().from(productionRequirement)
        .where(eq(productionRequirement.alembicRequirementId, aggregateId)).limit(1).for('update'))[0];
      const productionOrderId = req?.productionOrderId ?? null;

      let handedOver = 0;
      if (productionOrderId) {
        const rows = (await tx.execute(sql`
          with target as (
            select r.finished_good_reservation_id, r.finished_good_batch_id, r.reserved_qty, r.uom_id
              from packaging.finished_good_reservation r
              join packaging.finished_good_batch_master fg on fg.finished_good_batch_id = r.finished_good_batch_id
              join packaging.package_order po on po.package_order_id = fg.package_order_id
              join production.oil_batch_master ob on ob.oil_batch_id = po.oil_batch_id
             where ob.production_order_id = ${productionOrderId}
               and r.released_dt is null and coalesce(r.status, 'ACTIVE') = 'ACTIVE'
             for update of r
          ), upd as (
            update packaging.finished_good_reservation r
               set status = 'HANDED_OVER', released_dt = now(), updated_dt = now(), updated_by = 'bridge:alembic'
              from target t where r.finished_good_reservation_id = t.finished_good_reservation_id
            returning r.finished_good_reservation_id
          )
          insert into packaging.finished_goods_batch_consumption
            (finished_goods_batch_consumption_id, finished_good_batch_id, consumed_for_document_id,
             consumed_qty, uom_id, consumed_dt, status, created_by, updated_by)
          select gen_random_uuid(), t.finished_good_batch_id, ${aggregateId}::uuid,
                 t.reserved_qty, t.uom_id, now(), 'ACTIVE', 'bridge:alembic', 'bridge:alembic'
            from target t
          returning finished_goods_batch_consumption_id
        `)) as unknown as unknown[];
        handedOver = rows.length;
      }

      const fgNote = !productionOrderId
        ? 'no linked production order; no FG reservation to hand over'
        : handedOver > 0
          ? `${handedOver} FG reservation(s) marked HANDED_OVER`
          : 'no active FG reservation for the linked production order';
      const statusReason = `fulfilled: ALEMBIC goods receipt ${receiptRef || '(no ref)'}`
        + ` received ${receivedQty} ${uom}`.trimEnd() + `; ${fgNote}`;

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
    });
  }
}
