/**
 * G3 rule: QC HOLD age / overdue PR/PO → alert rows via the EXISTING alerts mechanism
 * (platform.notification_log — backend/api/src/automation/alerts.service.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ensureSchema, testClient, closeTestClient, TEST_DATABASE_URL } from '../../../../test-support/db.js';
import { AutomationAlertsService } from '../alerts.service.js';
import { isoOf } from '../../pg-timestamp.js';

let svc: AutomationAlertsService;

before(async () => {
  await ensureSchema();
  svc = new AutomationAlertsService(testClient() as never);
});
after(async () => {
  await closeTestClient();
});

function scan(): Promise<void> {
  return (svc as unknown as { scan(): Promise<void> }).scan();
}

test('a QC HOLD past the age threshold raises exactly one alert row', async () => {
  const sql = testClient();
  const rmBatchId = randomUUID();
  await sql`insert into inventory.rm_batch_master (rm_batch_id, batch_number, status) values (${rmBatchId}, ${'RMB-' + rmBatchId.slice(0, 8)}, 'QUARANTINE')`;
  const qcInspectionId = randomUUID();
  await sql`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status, updated_dt)
    values (${qcInspectionId}, ${rmBatchId}, 'HOLD', 'HOLD', now() - interval '100 hours')`;

  await scan();

  const alerts = await sql`select event_type, channel, status from platform.notification_log where event_type = 'quality.qc.hold_overdue' and body like ${'%' + qcInspectionId + '%'}`;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.channel, 'ALERT');
  assert.equal(alerts[0]?.status, 'LOGGED');

  // A second scan must not raise a duplicate — one alert per offending record, ever.
  await scan();
  const alertsAfter = await sql`select count(*)::int as c from platform.notification_log where event_type = 'quality.qc.hold_overdue' and body like ${'%' + qcInspectionId + '%'}`;
  assert.equal(alertsAfter[0]?.c, 1);
});

test('a QC HOLD that has NOT yet crossed the age threshold raises nothing', async () => {
  const sql = testClient();
  const rmBatchId = randomUUID();
  await sql`insert into inventory.rm_batch_master (rm_batch_id, batch_number, status) values (${rmBatchId}, ${'RMB-' + rmBatchId.slice(0, 8)}, 'QUARANTINE')`;
  const qcInspectionId = randomUUID();
  await sql`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status, updated_dt)
    values (${qcInspectionId}, ${rmBatchId}, 'HOLD', 'HOLD', now() - interval '1 hour')`;

  await scan();

  const alerts = await sql`select count(*)::int as c from platform.notification_log where body like ${'%' + qcInspectionId + '%'}`;
  assert.equal(alerts[0]?.c, 0);
});

test('a purchase request SUBMITTED past the overdue threshold raises exactly one alert row', async () => {
  const sql = testClient();
  const prId = randomUUID();
  await sql`insert into procurement.purchase_request (purchase_request_id, pr_number, status, updated_dt)
    values (${prId}, ${'PR-' + prId.slice(0, 8)}, 'SUBMITTED', now() - interval '100 hours')`;

  await scan();

  const alerts = await sql`select event_type, recipient from platform.notification_log where event_type = 'procurement.pr.overdue' and body like ${'%' + prId.slice(0, 8) + '%'}`;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.recipient, 'role:procurement');

  await scan();
  const alertsAfter = await sql`select count(*)::int as c from platform.notification_log where event_type = 'procurement.pr.overdue' and body like ${'%' + prId.slice(0, 8) + '%'}`;
  assert.equal(alertsAfter[0]?.c, 1, 'exactly one alert despite 2 scans');
});

test('a purchase order pending past the overdue threshold raises exactly one alert row', async () => {
  const sql = testClient();
  const poId = randomUUID();
  await sql`insert into procurement.purchase_order (purchase_order_id, po_number, status, updated_dt)
    values (${poId}, ${'PO-' + poId.slice(0, 8)}, 'PENDING_APPROVAL', now() - interval '100 hours')`;

  await scan();

  const alerts = await sql`select event_type from platform.notification_log where event_type = 'procurement.po.overdue' and body like ${'%' + poId.slice(0, 8) + '%'}`;
  assert.equal(alerts.length, 1);
});

// RC7 — "automation alerts scan failed: r.updated_dt.toISOString is not a function" (seen on the demo). In the
// running API the PG_CLIENT pool is also wrapped by Drizzle (DrizzleModule: IAM_DB / PLATFORM_DB), and
// drizzle-orm's postgres-js driver replaces the client's timestamp parsers with a pass-through, so these raw
// queries get `updated_dt` as TEXT. The scan threw on the first row and raised nothing at all.
test('the scan raises QC-HOLD, PR and PO alerts on a Drizzle-wrapped pool, where timestamps arrive as strings', async () => {
  const wrapped = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, types: {}, onnotice: () => {} });
  drizzle(wrapped); // exactly what DrizzleModule does to the shared PG_CLIENT
  try {
    const [probe] = await wrapped`select now() as t`;
    assert.equal(typeof probe?.t, 'string', 'precondition: the Drizzle-wrapped pool returns timestamps as strings');

    const sql = testClient();
    const rmBatchId = randomUUID();
    const qcInspectionId = randomUUID();
    const prId = randomUUID();
    const poId = randomUUID();
    // Far older than anything else in the table, so each lands inside its scan's `limit 100` (oldest first).
    await sql`insert into inventory.rm_batch_master (rm_batch_id, batch_number, status) values (${rmBatchId}, ${'RMB-' + rmBatchId.slice(0, 8)}, 'QUARANTINE')`;
    await sql`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result, status, updated_dt)
      values (${qcInspectionId}, ${rmBatchId}, 'HOLD', 'HOLD', now() - interval '3650 days')`;
    await sql`insert into procurement.purchase_request (purchase_request_id, pr_number, status, updated_dt)
      values (${prId}, ${'PR-' + prId.slice(0, 8)}, 'SUBMITTED', now() - interval '3650 days')`;
    await sql`insert into procurement.purchase_order (purchase_order_id, po_number, status, updated_dt)
      values (${poId}, ${'PO-' + poId.slice(0, 8)}, 'PENDING_APPROVAL', now() - interval '3650 days')`;

    const onWrapped = new AutomationAlertsService(wrapped as never);
    await (onWrapped as unknown as { scan(): Promise<void> }).scan();

    for (const [eventType, needle] of [
      ['quality.qc.hold_overdue', qcInspectionId],
      ['procurement.pr.overdue', prId.slice(0, 8)],
      ['procurement.po.overdue', poId.slice(0, 8)],
    ] as const) {
      const rows = await sql`select body from platform.notification_log where event_type = ${eventType} and body like ${'%' + needle + '%'}`;
      assert.equal(rows.length, 1, `${eventType}: exactly one alert row`);
      assert.match(String(rows[0]?.body), / since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z, past /, `${eventType}: ISO timestamp in the body`);
    }
  } finally {
    await wrapped.end({ timeout: 1 });
  }
});

test('isoOf: a Date, Postgres timestamptz text, and an unparseable value', () => {
  assert.equal(isoOf(new Date('2026-09-24T10:00:00.123Z')), '2026-09-24T10:00:00.123Z');
  assert.equal(isoOf('2026-09-24 10:00:00.123456+00'), '2026-09-24T10:00:00.123Z');
  assert.equal(isoOf('2026-09-24 15:30:00+05:30'), '2026-09-24T10:00:00.000Z');
  assert.equal(isoOf('not a time'), 'not a time', 'never throws: an alert with the raw text beats no alert');
});
