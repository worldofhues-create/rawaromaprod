/**
 * DisplayService (lane pf-c, plan section 2) — what a paired TV shows: the floor queue (lane A's
 * production.floor_job: job number, stage, order ref, promise; never a formula), the maceration
 * timers ("Day 23 of 45"), the QC backlog (batches ready for QC 2; finished-good lots waiting for
 * packaging QC), the packing and logistics queues, and the station's open alerts. Read-only.
 */
import { Inject, Injectable } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { openAlerts } from './floor-alerts.js';
import { iso } from './floor-util.js';
import { MacerationService } from './maceration.service.js';

@Injectable()
export class DisplayService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql, private readonly maceration: MacerationService) {}

  async feed(station: string | null) {
    const queue = await this.sql`
      select job_no, stage, order_ref, promise_dt, expedite from production.floor_job
       where stage <> 'DONE' order by expedite desc, promise_dt nulls last, job_no limit 30`;
    const runs = await this.maceration.runs();
    const fgWaiting = await this.sql`
      select f.batch_number, f.created_dt from packaging.finished_good_batch_master f
       where not exists (select 1 from packaging.packaging_qc q where q.finished_good_batch_id = f.finished_good_batch_id)
       order by f.created_dt limit 20`;
    const shipments = await this.sql`
      select status, count(*)::int as n from sales.shipment where status in ('PACKING', 'PACKED', 'DOCS_READY', 'AWB_ASSIGNED', 'HOLD') group by status`;
    return {
      at: new Date().toISOString(),
      station,
      queue: queue.map((q) => ({ jobNo: String(q.job_no), stage: String(q.stage), orderRef: q.order_ref ?? null, promiseAt: iso(q.promise_dt), expedite: !!q.expedite })),
      maceration: runs.map((r) => ({ batchNumber: r.batchNumber, label: r.label, day: r.day, needDays: r.needDays, endsAt: r.endsAt, readyForQc2: r.readyForQc2, overMax: r.overMax, freezeDue: r.freezeRequired && !r.freezeDoneAt })),
      qcBacklog: {
        qc2Ready: runs.filter((r) => r.readyForQc2).map((r) => r.batchNumber),
        packagingQc: fgWaiting.map((f) => String(f.batch_number ?? '')),
      },
      shipments: Object.fromEntries(shipments.map((s) => [String(s.status), Number(s.n)])),
      alerts: await openAlerts(this.sql, station),
    };
  }
}
