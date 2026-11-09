/**
 * FLOOR-FIX-1 — the TV board and the kiosks read ONE queue (production-floor plan §5, §12.3).
 * The board used to sort `expedite desc, promise_dt` itself, which put every late job above every
 * new one: the TV told the floor to make a different job than the kiosk in front of them did.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, closeTestClient } from '../../../test-support/db.js';
import { DisplayService } from '../floor-ops/display.service.js';
import { MacerationService } from '../floor-ops/maceration.service.js';
import { FloorQueueService } from '../floor/floor-queue.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { FloorCodeService } from '../floor/floor-code.service.js';

before(ensureSchema);
after(closeTestClient);

test('TV board order is the kiosk queue order: New before Delayed, not promise date first', async () => {
  const sql = testClient();
  const t = randomUUID().slice(0, 6);
  const mk = async (no: string, promise: string | null, created: string) => {
    await sql`insert into production.floor_job (floor_job_id, job_no, production_order_id, material_pick_list_id, stage, promise_dt, created_dt)
      values (${randomUUID()}, ${no}, ${randomUUID()}, ${randomUUID()}, 'VERIFY', ${promise}, ${created})`;
  };
  // Created far in the past so they sit at the head of their lanes whatever else is on the floor.
  await mk(`TVN-${t}`, null, '2001-01-02T00:00:00Z');
  await mk(`TVD-${t}`, '2001-01-05T00:00:00Z', '2001-01-01T00:00:00Z');
  const queue = new FloorQueueService(sql, new PolicyService(sql), new FloorCodeService(sql));
  const display = new DisplayService(sql, new MacerationService(sql), queue);
  const kiosk = (await queue.queue()).items.filter((i) => i.priority !== 'HOLD').slice(0, 30).map((i) => i.jobNo);
  const tv = (await display.feed(null)).queue.map((q) => q.jobNo);
  assert.deepEqual(tv, kiosk, 'the TV shows exactly the kiosk order');
  const mine = tv.filter((n) => n.endsWith(t));
  assert.deepEqual(mine, [`TVN-${t}`, `TVD-${t}`], 'strict alternation takes New first');
  // A board built without an injected queue (worker, older callers) still uses the same function.
  const plain = (await new DisplayService(sql, new MacerationService(sql)).feed(null)).queue.map((q) => q.jobNo);
  assert.deepEqual(plain, kiosk);
});
