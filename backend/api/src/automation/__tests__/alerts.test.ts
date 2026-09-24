/**
 * G3 rule: QC HOLD age / overdue PR/PO → alert rows via the EXISTING alerts mechanism
 * (platform.notification_log — backend/api/src/automation/alerts.service.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureSchema, testClient, closeTestClient } from '../../../../test-support/db.js';
import { AutomationAlertsService } from '../alerts.service.js';

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
