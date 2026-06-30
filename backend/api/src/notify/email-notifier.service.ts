/**
 * EmailNotifierService — Module 12 email half. Runs in the worker process and POLLS every cluster's
 * transactional outbox for notification-worthy domain events, renders an email per event, dispatches
 * it via EmailTransport, and records the result in platform.notification_log (idempotent on the
 * outbox event id). Polling (rather than the in-proc EventBus) is deliberate: the bus is per-Nest-
 * context and the worker is a separate context from the API app, so polling the shared DB is robust.
 */
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { EmailTransport } from './email-transport.service.js';

/** event type → { subject } for the events worth emailing. */
const RULES: Record<string, { subject: string }> = {
  'quality.qc.failed': { subject: 'QC FAILED — batch needs attention' },
  'procurement.po.issued': { subject: 'Purchase order issued' },
  'procurement.pr.submitted': { subject: 'Purchase request awaiting approval' },
  'formula.version.approved': { subject: 'Formula version approved & sealed' },
  'sales.order.confirmed': { subject: 'Sales order confirmed' },
  'sales.dispatch.created': { subject: 'Dispatch created' },
  'packaging.fg_batch.created': { subject: 'Finished-goods batch released' },
  'inventory.grn.created': { subject: 'Goods received (GRN raised)' },
};
const COND_TYPE = 'production.qc.recorded'; // only notify on FAIL/HOLD
const TYPES = [...Object.keys(RULES), COND_TYPE];
const SCHEMAS = ['procurement', 'quality', 'production', 'packaging', 'sales', 'formula', 'inventory'];

@Injectable()
export class EmailNotifierService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailNotifierService.name);
  private readonly to = process.env.NOTIFY_TO || 'owner@rawaroma.local';
  private readonly pollMs = Number(process.env.NOTIFY_POLL_MS) || 5000;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly transport: EmailTransport,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
    this.logger.log(`email notifier polling outbox every ${this.pollMs}ms`);
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const union = SCHEMAS.map((s) => `select id, type, payload::text as payload, occurred_at from ${s}.outbox`).join(' union all ');
      const inList = TYPES.map((t) => `'${t}'`).join(',');
      const rows = (await this.sql.unsafe(
        `select id, type, payload, occurred_at from (${union}) e
         where e.type in (${inList})
           and not exists (select 1 from platform.notification_log nl where nl.event_id = e.id)
         order by e.occurred_at desc limit 50`,
      )) as Array<{ id: string; type: string; payload: string | null }>;
      for (const r of rows) await this.notify(r);
    } catch (e) {
      this.logger.warn(`notifier drain failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async notify(r: { id: string; type: string; payload: string | null }): Promise<void> {
    let payload: Record<string, unknown> = {};
    try { payload = r.payload ? JSON.parse(r.payload) : {}; } catch { /* ignore */ }
    let rule = RULES[r.type];
    if (r.type === COND_TYPE) {
      const res = String(payload.result ?? '');
      if (!/FAIL|HOLD/i.test(res)) return;
      rule = { subject: `Production QC ${res.toUpperCase()}` };
    }
    if (!rule) return;
    const body = `${rule.subject}\n\nEvent: ${r.type}\nDetails: ${r.payload ?? '{}'}\n\n— RAW AROMACHEM notifications`;
    let result;
    try { result = await this.transport.send(this.to, rule.subject, body); }
    catch (err) { result = { status: 'FAILED' as const, error: (err as Error).message }; }
    await this.sql`
      insert into platform.notification_log
        (notification_log_id, event_id, event_type, channel, recipient, subject, body, status, error)
      values (${this.uuid()}, ${r.id}, ${r.type}, 'email', ${this.to}, ${rule.subject}, ${body}, ${result.status}, ${result.error ?? null})
      on conflict (event_id) do nothing`;
  }

  private uuid(): string {
    return (globalThis.crypto?.randomUUID?.() ?? require('node:crypto').randomUUID()) as string;
  }
}
