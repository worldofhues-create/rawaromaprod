/**
 * DisplayService (lane pf-c, plan section 2) — what a paired TV shows: the floor queue (lane A's
 * production.floor_job: job number, stage, order ref, promise; never a formula), the maceration
 * timers ("Day 23 of 45"), the QC backlog (batches ready for QC 2; finished-good lots waiting for
 * packaging QC), the packing and logistics queues, and the station's open alerts. Read-only.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PG_CLIENT } from '@core/backend-kernel';
import type { Sql } from 'postgres';
import { openAlerts } from './floor-alerts.js';
import { iso } from './floor-util.js';
import { MacerationService } from './maceration.service.js';
import { FgZoneService } from '../shelf/fg-zone.service.js';
import { FloorQueueService } from '../floor/floor-queue.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';

@Injectable()
export class DisplayService {
  private readonly floorQueue: FloorQueueService;

  // FLOOR-FIX-1: the board ranks with the kiosks' own FloorQueueService, never a sort of its own.
  // It used to order `expedite desc, promise_dt`, which put every late job above every new one, so
  // the TV named a different next job than the kiosk under it. Built from the same sql when not
  // injected, so a caller that predates the injection still gets the one queue function.
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly maceration: MacerationService,
    @Optional() floorQueue?: FloorQueueService,
  ) {
    this.floorQueue = floorQueue ?? new FloorQueueService(sql, new PolicyService(sql), new FloorCodeService(sql));
  }

  async feed(station: string | null) {
    // HELD jobs have no position on the kiosk either; the board shows the first 30 it would make.
    const queue = (await this.floorQueue.queue()).items.filter((q) => q.priority !== 'HOLD').slice(0, 30);
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
      queue: queue.map((q) => ({ jobNo: q.jobNo, stage: q.stage, orderRef: q.orderRef ?? null, promiseAt: iso(q.promiseDt), expedite: !!q.expedite, position: q.position, lane: q.lane })),
      maceration: runs.map((r) => ({ batchNumber: r.batchNumber, label: r.label, day: r.day, needDays: r.needDays, endsAt: r.endsAt, readyForQc2: r.readyForQc2, overMax: r.overMax, freezeDue: r.freezeRequired && !r.freezeDoneAt })),
      qcBacklog: {
        qc2Ready: runs.filter((r) => r.readyForQc2).map((r) => r.batchNumber),
        packagingQc: fgWaiting.map((f) => String(f.batch_number ?? '')),
      },
      shipments: Object.fromEntries(shipments.map((s) => [String(s.status), Number(s.n)])),
      alerts: await openAlerts(this.sql, station),
      // FLOOR-2 (F7): the FG rack, each lot with its zone's colour NAME and initials (never colour alone).
      fgRack: await new FgZoneService(this.sql).rack(),
    };
  }
}
