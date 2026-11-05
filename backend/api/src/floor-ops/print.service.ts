/**
 * PrintService (lane pf-c, plan section 2 + 12.4) — print jobs.
 *
 *   enqueue            a label/document, built ONCE as a template (web/label-render.js) at the
 *                      station printer's size. With a paired printer the job is `queued` for the
 *                      print agent; with none it is `browser` and the station prints the same
 *                      template in the browser, so the floor never stops.
 *   claimNext/report   the agent pulls its own printer's next job (row lock, SKIP LOCKED), renders
 *                      it in the printer's language and answers. Failures retry with backoff
 *                      (5 s, 10 s, 20 s … capped at 5 min); after max_attempts the job is
 *                      `parked` and an alert goes up at the station.
 *   sweepStale         a job the agent took and never answered for 2 minutes is failed (retried).
 *   reprint            only with a reason; a new job pointing at the original, naming the person,
 *                      and the label says REPRINT. A duplicate lot label is a recall risk.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import type { Sql } from 'postgres';
import { DevicesService, type PairedDevice } from './devices.service.js';
import { raiseAlert } from './floor-alerts.js';
import { FLOOR_CLOCK } from './floor.tokens.js';
import { iso, systemClock, type Clock } from './floor-util.js';
import { label, type LabelContent, type LabelTemplate } from './label-render.js';

export const STALE_SENT_MS = 2 * 60 * 1000;
const DEFAULT_SIZE = '100x50';

export interface EnqueueRequest {
  station: string;
  labelKind: string;
  subjectRef: string | null;
  content: LabelContent;
  /** Overrides the printer's configured size (e.g. an A4 document on the office printer). */
  size?: string;
  /** A specific printer; default: the station's first active label printer. */
  deviceId?: string | null;
}

@Injectable()
export class PrintService {
  private readonly clock: Clock;
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    readonly devices: DevicesService,
    @Optional() @Inject(FLOOR_CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? systemClock;
  }

  async enqueue(req: EnqueueRequest, principal: AuthPrincipal) {
    if (!req.station) throw new BadRequestException('station is required.');
    const printer = req.deviceId
      ? (await this.sql`select device_id, config from platform.device_master where device_id = ${req.deviceId}::uuid and kind = 'label_printer' and status <> 'revoked'`)[0]
      : (await this.sql`
          select device_id, config from platform.device_master
           where station = ${req.station} and kind = 'label_printer' and status in ('active', 'offline')
           order by (status = 'active') desc, created_at limit 1`)[0];
    const cfg = (printer?.config ?? {}) as Record<string, unknown>;
    const size = req.size ?? (typeof cfg.size === 'string' ? cfg.size : DEFAULT_SIZE);
    if (!label().SIZES[size]) throw new BadRequestException(`Unknown label size ${size}.`);
    const template = { ...label().build(req.content, size), src: req.content } as LabelTemplate;
    return this.insert({
      deviceId: printer ? String(printer.device_id) : null,
      station: req.station,
      labelKind: req.labelKind,
      subjectRef: req.subjectRef,
      template,
      reprintOf: null,
      reprintReason: null,
    }, principal);
  }

  private async insert(j: { deviceId: string | null; station: string; labelKind: string; subjectRef: string | null; template: LabelTemplate; reprintOf: string | null; reprintReason: string | null }, principal: AuthPrincipal) {
    const now = this.clock().toISOString();
    const [row] = await this.sql`
      insert into platform.print_job (print_job_id, device_id, station, label_kind, subject_ref, template, status, next_attempt_at,
                                      reprint_of, reprint_reason, requested_by, created_at, updated_at)
      values (${uuidv7()}::uuid, ${j.deviceId}::uuid, ${j.station}, ${j.labelKind}, ${j.subjectRef}, ${this.sql.json(JSON.parse(JSON.stringify(j.template)))},
              ${j.deviceId ? 'queued' : 'browser'}, ${now}::timestamptz, ${j.reprintOf}::uuid, ${j.reprintReason}, ${principal.userId}::uuid,
              ${now}::timestamptz, ${now}::timestamptz)
      returning *`;
    return this.shape(row!);
  }

  async get(id: string) {
    const [row] = await this.sql`select * from platform.print_job where print_job_id = ${id}::uuid`;
    if (!row) throw new NotFoundException('That print job was not found.');
    return this.shape(row);
  }

  async list(q: { station?: string | null; subjectRef?: string | null; status?: string | null; limit?: number }) {
    const lim = Math.min(Math.max(1, q.limit ?? 100), 500);
    const rows = await this.sql`
      select * from platform.print_job
       where true
         ${q.station ? this.sql`and station = ${q.station}` : this.sql``}
         ${q.subjectRef ? this.sql`and subject_ref = ${q.subjectRef}` : this.sql``}
         ${q.status ? this.sql`and status = ${q.status}` : this.sql``}
       order by created_at desc, print_job_id desc
       limit ${lim}`;
    return rows.map((r) => this.shape(r));
  }

  /** The agent's pull: its own printer's oldest due job, handed out once. */
  async claimNext(device: PairedDevice) {
    if (device.kind !== 'label_printer') throw new ForbiddenException('Only a paired printer pulls print jobs.');
    const now = this.clock().toISOString();
    const [row] = await this.sql`
      update platform.print_job set status = 'sent', attempts = attempts + 1, updated_at = ${now}::timestamptz
       where print_job_id = (
         select print_job_id from platform.print_job
          where device_id = ${device.deviceId}::uuid and status in ('queued', 'failed') and next_attempt_at <= ${now}::timestamptz
          order by created_at
          limit 1
          for update skip locked)
       returning *`;
    if (!row) return null;
    const job = this.shape(row);
    const language = String(device.config.language ?? 'zpl').toLowerCase();
    const dpi = Number(device.config.dpi ?? 203) || 203;
    return { ...job, language, rendered: label().render(job.template, language, { dpi }) };
  }

  async report(device: PairedDevice, id: string, result: { ok?: unknown; error?: unknown }) {
    const now = this.clock();
    return this.sql.begin(async (tx) => {
      const [job] = await tx`select * from platform.print_job where print_job_id = ${id}::uuid for update`;
      if (!job) throw new NotFoundException('That print job was not found.');
      if (String(job.device_id) !== device.deviceId) throw new ForbiddenException('That print job is not this printer\'s.');
      if (job.status !== 'sent') throw new ConflictException(`That print job is ${job.status}, not waiting for an answer.`);
      if (result.ok === true) {
        const [r] = await tx`update platform.print_job set status = 'printed', printed_at = ${now.toISOString()}::timestamptz, last_error = null, updated_at = ${now.toISOString()}::timestamptz where print_job_id = ${id}::uuid returning *`;
        return this.shape(r!);
      }
      return this.fail(tx as unknown as Sql, job, String(result.error ?? 'printer error').slice(0, 500), now);
    });
  }

  private async fail(sql: Sql, job: Record<string, unknown>, error: string, now: Date) {
    const attempts = Number(job.attempts);
    const parked = attempts >= Number(job.max_attempts);
    const next = new Date(now.getTime() + Math.min(5000 * 2 ** (attempts - 1), 5 * 60 * 1000));
    const [r] = await sql`
      update platform.print_job set status = ${parked ? 'parked' : 'failed'}, last_error = ${error},
             next_attempt_at = ${next.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
       where print_job_id = ${job.print_job_id as string}::uuid returning *`;
    if (parked) {
      await raiseAlert(sql, {
        kind: 'print_parked', station: String(job.station), subjectType: 'print_job', subjectId: String(job.print_job_id),
        title: `Label not printed: ${job.label_kind} ${job.subject_ref ?? ''}`.trim(),
        body: `Tried ${attempts} times (${error}). Print it in the browser, or fix the printer and send it again.`,
        dedupeKey: `print_parked:${job.print_job_id}`,
      }, now);
    }
    return this.shape(r!);
  }

  async sweepStale() {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - STALE_SENT_MS).toISOString();
    const stale = await this.sql`select * from platform.print_job where status = 'sent' and updated_at < ${cutoff}::timestamptz`;
    for (const j of stale) await this.fail(this.sql, j, 'no answer from the print agent', now);
    return { failed: stale.length };
  }

  async retry(id: string, _principal: AuthPrincipal) {
    const now = this.clock().toISOString();
    const [r] = await this.sql`
      update platform.print_job set status = 'queued', attempts = 0, next_attempt_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
       where print_job_id = ${id}::uuid and status in ('parked', 'failed') and device_id is not null returning *`;
    if (!r) throw new ConflictException('Only a failed or parked job for a paired printer can be sent again.');
    await this.sql`update platform.floor_alert set cleared_at = ${now}::timestamptz where dedupe_key = ${'print_parked:' + id} and cleared_at is null`;
    return this.shape(r);
  }

  /** The browser fallback printed it (the station's own print dialog). */
  async markBrowserPrinted(id: string, _principal: AuthPrincipal) {
    const now = this.clock().toISOString();
    const [r] = await this.sql`
      update platform.print_job set status = 'printed', printed_at = ${now}::timestamptz, updated_at = ${now}::timestamptz,
             last_error = case when status = 'browser' then null else coalesce(last_error, '') || ' (printed in the browser)' end
       where print_job_id = ${id}::uuid and status in ('browser', 'queued', 'failed', 'parked') returning *`;
    if (!r) throw new ConflictException('That job is already printed or on its way to the printer.');
    await this.sql`update platform.floor_alert set cleared_at = ${now}::timestamptz where dedupe_key = ${'print_parked:' + id} and cleared_at is null`;
    return this.shape(r);
  }

  async reprint(id: string, reason: unknown, principal: AuthPrincipal) {
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (!why) throw new BadRequestException('A reprint needs a reason (it is logged with your name).');
    if (why.length > 300) throw new BadRequestException('The reason must be at most 300 characters.');
    const orig = await this.get(id);
    const src = { ...(orig.template.src ?? {}), reprint: true };
    const template = orig.template.src
      ? ({ ...label().build(src, orig.template.size), src } as LabelTemplate)
      : ({ ...orig.template, reprint: true } as LabelTemplate);
    const [dev] = orig.deviceId
      ? await this.sql`select device_id from platform.device_master where device_id = ${orig.deviceId}::uuid and status in ('active', 'offline')`
      : [];
    return this.insert({
      deviceId: dev ? String(dev.device_id) : null,
      station: orig.station, labelKind: orig.labelKind, subjectRef: orig.subjectRef, template,
      reprintOf: orig.reprintOf ?? orig.printJobId, reprintReason: why,
    }, principal);
  }

  /** True when every job for this subject+kind has printed (agent or browser). */
  async printed(labelKind: string, subjectRef: string): Promise<boolean> {
    const [r] = await this.sql`select count(*) filter (where status = 'printed')::int as ok, count(*)::int as n from platform.print_job where label_kind = ${labelKind} and subject_ref = ${subjectRef}`;
    return Number(r?.ok ?? 0) > 0;
  }

  private shape(r: Record<string, unknown>) {
    const template = (typeof r.template === 'string' ? JSON.parse(r.template) : r.template) as LabelTemplate;
    return {
      printJobId: String(r.print_job_id),
      deviceId: (r.device_id as string | null) ?? null,
      station: String(r.station),
      labelKind: String(r.label_kind),
      subjectRef: (r.subject_ref as string | null) ?? null,
      status: String(r.status),
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      nextAttemptAt: iso(r.next_attempt_at),
      lastError: (r.last_error as string | null) ?? null,
      reprintOf: (r.reprint_of as string | null) ?? null,
      reprintReason: (r.reprint_reason as string | null) ?? null,
      requestedBy: (r.requested_by as string | null) ?? null,
      printedAt: iso(r.printed_at),
      createdAt: iso(r.created_at),
      template,
      /** The browser fallback for this exact template. */
      html: label().render(template, 'html').body,
    };
  }
}
