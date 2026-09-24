/**
 * RelayService (bridge) — drains `bridge.outbox` toward ALEMBIC's inbound webhook, signed
 * per docs/bridge/EVENT_CONTRACT.md. Scheduled the same way `OutboxPublisher` drains every
 * other cluster's outbox (`@Interval`, re-entrancy guarded) — reusing the existing
 * worker-process pattern rather than inventing a second one, per the lane brief. Runs in
 * the `worker` process (registered in worker.module.ts), same as the publisher.
 *
 * Fails closed: an unconfigured connector (no URL, no openable secret) delivers nothing
 * and leaves every event queued.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from './bridge.tokens.js';
import { openSecret } from './secret-box.js';
import { signBody } from './signing.js';

const { outbox, connectorConfig, productionRequirement } = bridgeSchema;

@Injectable()
export class BridgeRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(BridgeRelayService.name);
  private draining = false;
  private stopped = false;

  constructor(@Inject(BRIDGE_DB) private readonly db: BridgeDb) {}

  onModuleDestroy(): void {
    this.stopped = true;
  }

  @Interval('bridge-outbound-drain', 2000)
  async tick(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      await this.drain();
    } catch (err) {
      this.logger.error(`bridge outbound drain failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.draining = false;
    }
  }

  private async drain(): Promise<void> {
    const config = (await this.db.select().from(connectorConfig)
      .where(eq(connectorConfig.id, 'default')).limit(1))[0];
    const secret = config?.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;

    if (!config?.enabled || !config.webhookUrl || !secret) return; // fail closed, stays queued

    const pending = await this.db.select().from(outbox)
      .where(and(isNull(outbox.publishedAt)))
      .orderBy(asc(outbox.seq))
      .limit(50);

    for (const ev of pending) {
      const rawPayload = { ...(ev.payload as Record<string, unknown>) };
      const version = typeof rawPayload._bridge_version === 'number' ? rawPayload._bridge_version : 1;
      delete rawPayload._bridge_version; // transport metadata, not part of the safe payload

      const req = ev.aggregateId
        ? (await this.db.select({ orgId: productionRequirement.orgId }).from(productionRequirement)
            .where(eq(productionRequirement.alembicRequirementId, ev.aggregateId)).limit(1))[0]
        : undefined;

      // G1/PB-08: not every bridge.outbox row is about a production_requirement any more —
      // emitBridgeManualEvent (bridge-emit.ts) writes rows for other RawProd aggregates (e.g. a
      // sales order) that have no production_requirement to look an org id up from. Rather than
      // mislabel every such row as 'production_requirement' (the aggregate.type this envelope
      // used to hardcode unconditionally), resolve it from the event's own name: this codebase's
      // event-type convention is PascalCase starting with the aggregate's noun (Production*,
      // SalesOrder*, …), so a type this relay doesn't recognize as production-requirement-shaped
      // is reported as the aggregate it actually names instead of a silently wrong guess.
      const aggregateType = ev.type.startsWith('SalesOrder') ? 'sales_order' : 'production_requirement';

      const body = JSON.stringify({
        event_id: ev.id,
        version,
        type: ev.type,
        org_id: req?.orgId ?? null,
        correlation_id: rawPayload.correlation_id ?? ev.aggregateId,
        causation_id: null,
        occurred_at: ev.occurredAt.toISOString(),
        source: 'rawprod',
        aggregate: { type: aggregateType, id: ev.aggregateId },
        payload: rawPayload,
      });
      try {
        const res = await fetch(config.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-bridge-event-id': ev.id,
            'x-bridge-signature': signBody(body, secret),
          },
          body,
        });
        if (res.ok) {
          await this.db.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, ev.id));
        } else {
          await this.db.update(outbox).set({ attempts: (ev.attempts ?? 0) + 1 }).where(eq(outbox.id, ev.id));
        }
      } catch (err) {
        this.logger.warn(`bridge delivery failed for ${ev.id}: ${err instanceof Error ? err.message : String(err)}`);
        await this.db.update(outbox).set({ attempts: (ev.attempts ?? 0) + 1 }).where(eq(outbox.id, ev.id));
      }
    }
  }
}
