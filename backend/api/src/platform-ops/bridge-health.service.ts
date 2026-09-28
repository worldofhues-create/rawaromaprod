/**
 * BridgeHealthService (lane produce, owner requirement 2026-09-29: "Platform shows the bridge
 * health/counters") — the ALEMBIC ↔ RawProd channel at a glance for the Platform console:
 *
 *   inbound     events ALEMBIC sent in the last 24 h (applied / parked / duplicate-free), the
 *               parked total by reason, and when the last one arrived;
 *   outbound    RawProd → ALEMBIC: waiting, parked (by reason), delivered in 24 h, last delivery,
 *               and the 24 h mix by type (so `fg.batch.received` / `qc.batch.released` traffic shows);
 *   requirements  by lifecycle status, plus the production-queue counters (open, kg to produce,
 *               overdue, high value, blocked);
 *   connector   configured or not (never the URL's secret or the HMAC secret);
 *   pickLight   the pick-to-light connector's mode and queue (never its secret).
 *
 * Counts and timestamps only — no payload, no customer, no formula content.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { ProduceQueueService } from '@ra/cluster-production';
import { PickLightService } from '../shelf/pick-light.service.js';

const n = (v: unknown) => Number(v ?? 0) || 0;
const t = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

@Injectable()
export class BridgeHealthService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Optional() private readonly queue?: ProduceQueueService,
    @Optional() private readonly lights?: PickLightService,
  ) {}

  async health() {
    const sql = this.sql;
    const [inb] = await sql`
      select count(*) filter (where received_at > now() - interval '24 hours')::int as last24,
             count(*) filter (where received_at > now() - interval '24 hours' and processed_at is not null)::int as applied24,
             count(*) filter (where parked_reason is not null)::int as parked,
             max(received_at) as last_at
        from bridge.inbound_event`;
    const inboundParked = await sql`
      select parked_reason as reason, count(*)::int as count from bridge.inbound_event
       where parked_reason is not null group by 1 order by 2 desc`;
    const [out] = await sql`
      select count(*) filter (where o.published_at is null and (d.outbox_id is null or (d.parked_at is null and d.discarded_at is null)))::int as waiting,
             count(*) filter (where o.published_at is null and d.parked_at is not null and d.discarded_at is null)::int as parked,
             count(*) filter (where o.published_at > now() - interval '24 hours')::int as delivered24,
             max(o.published_at) as last_delivered,
             min(o.occurred_at) filter (where o.published_at is null and d.parked_at is null) as oldest_waiting
        from bridge.outbox o left join bridge.outbox_delivery d on d.outbox_id = o.id`;
    const outboundParked = await sql`
      select d.parked_reason as reason, count(*)::int as count from bridge.outbox_delivery d
        join bridge.outbox o on o.id = d.outbox_id
       where d.parked_at is not null and d.discarded_at is null and o.published_at is null group by 1 order by 2 desc`;
    const byType = await sql`
      select type, count(*)::int as count, count(*) filter (where published_at is not null)::int as delivered
        from bridge.outbox where occurred_at > now() - interval '24 hours' group by type order by 2 desc`;
    const reqs = await sql`select lifecycle_status as status, count(*)::int as count from bridge.production_requirement group by 1 order by 1`;
    const [conn] = await sql`select enabled, webhook_url is not null as url, hmac_secret_sealed is not null as secret, configured_at
                               from bridge.connector_config where id = 'default'`;
    let queue: unknown = null;
    if (this.queue) {
      try { queue = (await this.queue.queue(500)).counters; } catch { queue = null; }
    }
    let pickLight: unknown = null;
    if (this.lights) {
      const s = await this.lights.status();
      pickLight = { mode: s.mode, controllerConfigured: !!s.controllerUrl, hasSecret: s.hasSecret, pending: s.pending, parked: s.parked, lastSentAt: s.lastSentAt };
    }
    return {
      at: new Date().toISOString(),
      connector: { configured: !!(conn?.url && conn?.secret), enabled: !!conn?.enabled, configuredAt: t(conn?.configured_at) },
      inbound: { last24h: n(inb?.last24), applied24h: n(inb?.applied24), parked: n(inb?.parked), lastAt: t(inb?.last_at), parkedByReason: inboundParked },
      outbound: {
        waiting: n(out?.waiting), parked: n(out?.parked), delivered24h: n(out?.delivered24),
        lastDeliveredAt: t(out?.last_delivered), oldestWaitingAt: t(out?.oldest_waiting),
        parkedByReason: outboundParked, byType24h: byType,
      },
      requirements: reqs,
      queue,
      pickLight,
    };
  }
}
