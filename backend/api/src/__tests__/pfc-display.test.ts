/**
 * Lane pf-c (plan section 2): the TV board — floor-ops/display.service.ts. It shows the floor queue
 * by job number and stage, maceration days, the QC backlog and the station's alerts, and carries no
 * formula, ingredient or price.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';
import { DisplayService } from '../floor-ops/display.service.js';
import { MacerationService } from '../floor-ops/maceration.service.js';
import { raiseAlert } from '../floor-ops/floor-alerts.js';

let display: DisplayService;
before(async () => {
  await ensureSchema();
  display = new DisplayService(testClient(), new MacerationService(testClient()));
});
after(async () => closeTestClient());

test('board: queue, maceration timers, QC backlog and the station alerts; nothing secret', async () => {
  const sql = testClient();
  const job = `J-${randomUUID().slice(0, 6)}`;
  await sql`insert into production.floor_job (floor_job_id, job_no, production_order_id, material_pick_list_id, stage, expedite, order_ref)
            values (${randomUUID()}, ${job}, ${randomUUID()}, ${randomUUID()}, 'VERIFY', true, 'SO-TV')`;
  const oil = randomUUID();
  await sql`insert into production.oil_batch_master (oil_batch_id, batch_number, status) values (${oil}, ${'TV-' + oil.slice(0, 4)}, 'IN_MATURATION')`;
  await sql`insert into production.maceration_run (maceration_run_id, oil_batch_id, status, started_at, min_days, max_days, qc1_production_qc_id)
            values (${randomUUID()}, ${oil}, 'MACERATING', now() - interval '22 days', 45, 90, ${randomUUID()})`;
  const st = `TV ${randomUUID().slice(0, 4)}`;
  await raiseAlert(sql, { kind: 'device_offline', station: st, subjectType: 'device', subjectId: null, title: 'Printer offline: Zebra', dedupeKey: `t:${st}` }, new Date());
  const f = await display.feed(st);
  const q = f.queue.find((x) => x.jobNo === job)!;
  assert.deepEqual([q.stage, q.expedite, q.orderRef], ['VERIFY', true, 'SO-TV']);
  const m = f.maceration.find((x) => x.batchNumber === 'TV-' + oil.slice(0, 4))!;
  assert.equal(m.label, 'Day 23 of 45');
  assert.equal(m.readyForQc2, false);
  assert.equal(f.alerts.length, 1);
  assert.ok(!/formula|ingredient|percent|price|rate|amount/i.test(JSON.stringify(Object.keys(f.queue[0] ?? {}))));
});
