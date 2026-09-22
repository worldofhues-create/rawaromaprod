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
}
