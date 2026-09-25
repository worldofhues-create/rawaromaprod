/**
 * RelayService (bridge) — drains `bridge.outbox` toward ALEMBIC's inbound webhook, signed
 * per docs/bridge/EVENT_CONTRACT.md. Scheduled the same way `OutboxPublisher` drains every
 * other cluster's outbox (`@Interval`, re-entrancy guarded) — reusing the existing
 * worker-process pattern rather than inventing a second one, per the lane brief. Runs in
 * the `worker` process (registered in worker.module.ts), same as the publisher.
 *
 * Fails closed: an unconfigured connector (no URL, no openable secret) delivers nothing
 * and leaves every event queued.
 *
 * POISON EVENTS (OPS_GREEN §17, P1) — the mirror of ALEMBIC's sweep. A non-2xx used to bump
 * `attempts` and re-POST the same bytes every 2 s for ever. Now every failure is classified
 * (`decideFailedDelivery` in contract.ts): a PERMANENT refusal (ALEMBIC's 400 +
 * `permanent: true`, e.g. a type it does not accept) parks the event after ONE attempt; a
 * TRANSIENT one (network, 5xx, 401) backs off exponentially and parks at 12 attempts. State
 * lives in `bridge.outbox_delivery`; a park is audited in `bridge.audit_events` and listed at
 * GET /v1/bridge/outbox/parked for replay/discard (outbox-admin.service.ts). A later event for
 * an aggregate is held behind its parked predecessor, since ALEMBIC applies strictly in order.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { BRIDGE_DB, bridgeSchema, type BridgeDb } from './bridge.tokens.js';
import { openSecret } from './secret-box.js';
import { signBody } from './signing.js';
import { decideFailedDelivery, describeFailure, type DeliveryFailure } from './contract.js';

const { outbox, connectorConfig, productionRequirement, auditEvents } = bridgeSchema;

interface PendingRow {
  id: string; type: string; payload: unknown; aggregate_id: string | null;
  occurred_at: Date | string; attempts: number;
}

/** The receiver's JSON body, if any; never throws. */
async function readBody(res: Response): Promise<unknown> {
  try {
    const text = typeof res.text === 'function' ? await res.text() : '';
    return text ? JSON.parse(text.slice(0, 4096)) : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class BridgeRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(BridgeRelayService.name);
  private draining = false;
  private stopped = false;
  /** The transport. A seam for the bridge-poison tests; production uses the global fetch. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

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

  /** One pass over the due queue. Public so a test can drive a pass without the timer. */
  async drain(): Promise<void> {
    const config = (await this.db.select().from(connectorConfig)
      .where(eq(connectorConfig.id, 'default')).limit(1))[0];
    const secret = config?.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;

    if (!config?.enabled || !config.webhookUrl || !secret) return; // fail closed, stays queued

    // Due, not parked, not discarded, and not behind a parked event for the same aggregate.
    const pending = (await this.db.execute(sql`
      select o.id, o.type, o.payload, o.aggregate_id, o.occurred_at,
             coalesce(d.attempts, 0)::int as attempts
        from bridge.outbox o
        left join bridge.outbox_delivery d on d.outbox_id = o.id
       where o.published_at is null
         and (d.outbox_id is null
              or (d.parked_at is null and d.discarded_at is null and d.next_attempt_at <= now()))
         and not exists (
           select 1 from bridge.outbox p
             join bridge.outbox_delivery pd on pd.outbox_id = p.id
            where p.aggregate_id = o.aggregate_id and p.published_at is null
              and pd.parked_at is not null and pd.discarded_at is null
              and p.seq < o.seq)
       order by o.occurred_at, o.seq
       limit 50
    `)) as unknown as PendingRow[];

    for (const row of pending) {
      const ev = {
        id: row.id, type: row.type, payload: row.payload, aggregateId: row.aggregate_id,
        occurredAt: row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at),
        attempts: Number(row.attempts),
      };
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
      let res: Response;
      try {
        res = await this.fetchImpl(config.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-bridge-event-id': ev.id,
            'x-bridge-signature': signBody(body, secret),
          },
          body,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`bridge delivery failed for ${ev.id}: ${message}`);
        await this.recordFailure(ev, {}, message);
        continue;
      }
      if (res.ok) {
        await this.db.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, ev.id));
      } else {
        await this.recordFailure(ev, { status: res.status, body: await readBody(res) });
      }
    }
  }

  /** One failed attempt: classify, decide (retry after N s, or park), record, audit a park. */
  private async recordFailure(
    ev: { id: string; type: string; aggregateId: string | null; attempts: number },
    f: DeliveryFailure, networkMessage?: string,
  ): Promise<void> {
    const d = decideFailedDelivery(f, ev.attempts);
    const lastError = describeFailure(f, networkMessage);
    const httpStatus = f.status ?? null;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into bridge.outbox_delivery
          (outbox_id, attempts, next_attempt_at, last_error, last_http_status, parked_at, parked_reason, updated_at)
        values (${ev.id}::uuid, 1,
                now() + make_interval(secs => ${d.retryInSeconds ?? 0}::double precision),
                ${lastError}, ${httpStatus}::int,
                case when ${d.park}::text is null then null else now() end, ${d.park}::text, now())
        on conflict (outbox_id) do update set
          attempts = bridge.outbox_delivery.attempts + 1,
          next_attempt_at = excluded.next_attempt_at,
          last_error = excluded.last_error,
          last_http_status = excluded.last_http_status,
          parked_at = excluded.parked_at,
          parked_reason = excluded.parked_reason,
          updated_at = now()
      `);
      // Kept in step for anything that still reads the kernel column.
      await tx.update(outbox).set({ attempts: sql`${outbox.attempts} + 1` }).where(eq(outbox.id, ev.id));
      if (d.park) {
        await tx.insert(auditEvents).values({
          actorId: null,
          action: 'bridge.outbox_parked',
          entityType: 'bridge_outbox',
          entityId: ev.id,
          after: {
            type: ev.type, aggregateId: ev.aggregateId, reason: d.park,
            attempts: ev.attempts + 1, lastError, httpStatus,
          },
          occurredAt: new Date(),
        });
      }
    });
    if (d.park) {
      this.logger.warn(`bridge event ${ev.id} (${ev.type}) parked: ${d.park} (${lastError})`);
    }
  }
}
