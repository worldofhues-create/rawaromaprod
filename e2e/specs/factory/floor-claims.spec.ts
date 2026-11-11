/* FLOOR-LOT-STOP-1, FLOOR-QC-IN-1, FLOOR-TEMP-1 walked in the browser: a wrong lot stops the line until a
 * supervisor resumes it; a quarantined lot cannot be picked or issued; a temperature excursion logged at
 * the Temperatures screen holds the lots in the zone. Every row here is made by the walk; nothing is seeded.
 * FLOOR_CLAIMS_SHOTS names a folder to keep the screenshots in. */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { must } from '../../harness/chain';
import { factoryCall, openNav, signIn, sql, uniq } from '../../harness/walk';

const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const shot = async (page: Page, name: string) => {
  const dir = process.env.FLOOR_CLAIMS_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
};

type Info = Parameters<Parameters<typeof test>[1]>[1];
async function material(info: Info) {
  const fam = uniq('fcl', info).toLowerCase() + letters().toLowerCase();
  await must('admin', 'PUT', `/v1/floor/families/${fam}`, { familyName: 'Claims family', colourName: 'Tone' + letters(), colourHex: '#5A7D8B' });
  const mat = randomUUID();
  const code = uniq('MC', info) + letters();
  sql(`insert into masterdata.material (material_id, material_code, material_name, status) values ('${mat}', '${code}', 'Claims oil', 'ACTIVE')`);
  const fc = (await must('procurement', 'POST', '/v1/floor/codes', { materialId: mat, familyCode: fam })) as { code: string };
  return { id: mat, materialCode: code, floorCode: fc.code };
}
async function lot(info: Info, mat: string, opts: { status?: string; result?: string; binId?: string; binCode?: string } = {}) {
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'g', 'gram', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const rb = randomUUID(), ib = randomUUID();
  let bin = opts.binId, binCode = opts.binCode;
  if (!bin) { bin = randomUUID(); binCode = uniq('BC', info) + letters(); sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${bin}', '${binCode}', 'ACTIVE')`); }
  const batchNo = uniq('RMC', info) + letters();
  sql(`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values ('${rb}', '${mat}', '${batchNo}', '2099-01-01', '${opts.status ?? 'RELEASED'}')`);
  sql(`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values ('${randomUUID()}', '${rb}', '${opts.result ?? 'ACCEPT'}')`);
  sql(`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values ('${ib}', '${rb}', '${mat}', '${bin}', 1000, '${g}', 'ACTIVE')`);
  const r = (await must('warehouse', 'POST', `/v1/floor/lots/${ib}/barcode`)) as { barcode: string };
  return { inventoryBatchId: ib, rmBatchId: rb, barcode: r.barcode, bin: binCode!, binId: bin, batchNo };
}
async function job(mat: string) {
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const order = randomUUID(), pl = randomUUID();
  sql(`insert into production.production_order (production_order_id, order_qty, uom_id, status) values ('${order}', 1, '${g}', 'INPROGRESS')`);
  sql(`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values ('${pl}', '${order}', 'ACTIVE')`);
  sql(`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values ('${randomUUID()}', '${order}', '${mat}', 10, false, '${g}', 'ACTIVE')`);
  sql(`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values ('${randomUUID()}', '${pl}', '${mat}', 10, '${g}', 'ACTIVE')`);
  const j = (await must('production', 'POST', '/v1/floor/jobs', { productionOrderId: order })) as { floorJobId: string; jobNo: string };
  return { ...j, orderId: order, pickListId: pl };
}
async function scanAtPick(page: Page, j: { floorJobId: string }, bin: string, barcode: string) {
  await page.locator('#fl-bin').fill(bin);
  await page.locator('#fl-lot').fill(barcode);
  await page.locator('#fl-tick').click();
}

test('FLOOR-LOT-STOP-1: a wrong lot stops the line; the picker cannot resume it; a supervisor resumes with a reason', async ({ page }, info) => {
  const a = await material(info), b = await material(info);
  const right = await lot(info, a.id), wrong = await lot(info, b.id);
  const j = await job(a.id);
  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Pick');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await scanAtPick(page, j, wrong.bin, wrong.barcode);
  await expect(page.locator('#ra-view')).toContainText('LINE STOPPED');
  await expect(page.locator('#ra-view')).toContainText('Wrong material');
  await expect(page.locator('#ra-view')).toContainText(wrong.barcode);
  await expect(page.locator('#ra-view')).toContainText('Call a supervisor.');
  await expect(page.locator('#fl-tick')).toHaveCount(0);
  await shot(page, '01-wrong-lot-line-stopped-picker');
  // the stop is server-side: the right lot is refused too, by the route itself
  const line = sql(`select floor_line_id from production.floor_line where floor_job_id='${j.floorJobId}'`);
  const r = await factoryCall(page, 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/lines/${line}`, { bin: right.bin, barcode: right.barcode });
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.json)).toContain('stopped');
  expect(sql(`select kind from production.floor_line_stop where floor_job_id='${j.floorJobId}' and cleared_dt is null`)).toBe('WRONG_MATERIAL');

  await signIn(page, 'factory', 'production');
  const queue = await factoryCall(page, 'GET', '/v1/floor/queue?stage=PICK');
  expect(JSON.stringify(queue.json)).toContain('Wrong material');
  await openNav(page, 'Floor queue');
  await expect(page.locator('#ra-view')).toContainText('Line stopped');
  await shot(page, '02-floor-queue-line-stopped-alert');
  // the supervisor resumes from the stop screen (production holds production:floor_job:write)
  const res = await factoryCall(page, 'POST', `/v1/floor/jobs/${j.floorJobId}/stop/resume`, { reason: '' });
  expect(res.status).toBe(400);
  const ok = await factoryCall(page, 'POST', `/v1/floor/jobs/${j.floorJobId}/stop/resume`, { reason: 'Walk: wrong drum returned to its bin, picker re-briefed' });
  expect(ok.status).toBeLessThan(300);
  expect(sql(`select clear_reason from production.floor_line_stop where floor_job_id='${j.floorJobId}'`)).toBe('Walk: wrong drum returned to its bin, picker re-briefed');

  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Pick');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await expect(page.locator('#ra-view')).not.toContainText('LINE STOPPED');
  await scanAtPick(page, j, right.bin, right.barcode);
  await expect(page.locator('#fl-tote2')).toBeVisible();
  await shot(page, '03-resumed-right-lot-picked');
});

test('FLOOR-LOT-STOP-1 (supervisor view): the stop screen offers the resume to a supervisor', async ({ page }, info) => {
  const a = await material(info);
  await lot(info, a.id);
  const j = await job(a.id);
  await signIn(page, 'factory', 'picker');
  const line = sql(`select floor_line_id from production.floor_line where floor_job_id='${j.floorJobId}'`);
  await factoryCall(page, 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/lines/${line}`, { bin: 'X', barcode: 'L-ZZZZZZZ' });
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Floor queue');
  await expect(page.locator('#ra-view')).toContainText('Line stopped');
  await shot(page, '04-floor-queue-supervisor-resume');
  await page.locator(`[data-resume="${j.floorJobId}"]`).click();
  await page.getByLabel('What was wrong, and what was done?').fill('Walk: label torn, lot identified by hand and returned');
  await page.getByRole('button', { name: 'Resume the line' }).last().click();
  await expect.poll(() => sql(`select count(*) from production.floor_line_stop where floor_job_id='${j.floorJobId}' and cleared_dt is null`)).toBe('0');
});

test('FLOOR-QC-IN-1: a quarantined lot cannot be picked or issued; Scan a lot says it waits for QC', async ({ page }, info) => {
  const a = await material(info);
  // a released lot keeps the job ready; the picker scans the quarantined drum beside it instead
  await lot(info, a.id);
  const q = await lot(info, a.id, { status: 'QUARANTINE', result: 'PENDING' });
  const j = await job(a.id);
  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Pick');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await expect(page.locator('#ra-view')).not.toContainText(q.batchNo); // never directed to it
  await scanAtPick(page, j, q.bin, q.barcode);
  await expect(page.locator('#ra-view')).toContainText('LINE STOPPED');
  await expect(page.locator('#ra-view')).toContainText('not released by QC');
  await shot(page, '05-quarantined-lot-refused-at-pick');
  await openNav(page, 'Scan a lot');
  await page.locator('#ra-view input').first().fill(q.barcode);
  await page.keyboard.press('Enter');
  await expect(page.locator('#ra-view')).toContainText('Waiting for incoming QC');
  await shot(page, '06-scan-a-lot-quarantine');
  // consuming it directly through the issue route is refused too (compounding holds material_issue:write)
  await signIn(page, 'factory', 'compounding');
  const item = sql(`select material_pick_list_item_id from production.material_pick_list_items where material_pick_list_id='${j.pickListId}'`);
  const r = await factoryCall(page, 'POST', '/v1/material-issues', { productionOrderId: j.orderId, materialPickListId: j.pickListId, items: [{ materialPickListItemId: item, inventoryBatchId: q.inventoryBatchId }] });
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.json)).toContain('not released by QC');
});

test('FLOOR-TEMP-1: a reading outside a sourced limit, logged at the kiosk, holds the lots in the zone and raises the alarm', async ({ page }, info) => {
  const a = await material(info), other = await material(info);
  const binId = randomUUID(), binCode = uniq('BZ', info) + letters();
  sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${binId}', '${binCode}', 'ACTIVE')`);
  const held = await lot(info, a.id, { binId, binCode });
  await lot(info, a.id); // a lot outside the zone keeps the job ready, so the picker can scan the held one
  const noLimit = await lot(info, other.id, { binId, binCode });
  const zoneCode = (uniq('Z', info) + letters()).toUpperCase();
  // QC sets the zone up and the material's limit, with its source, on the Temperatures screen
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'Temperatures');
  await page.locator('#fl-zone-add').click();
  await page.getByLabel('Zone code (e.g. RM-STORE-A)').fill(zoneCode);
  await page.getByLabel('Name *', { exact: true }).fill('Walk RM store');
  await page.getByLabel('Log every (minutes)').fill('240');
  await page.getByLabel('Bin codes in this zone, separated by commas').fill(binCode);
  await page.getByRole('button', { name: 'Add zone' }).last().click();
  await expect(page.locator('#ra-view')).toContainText(zoneCode);
  await expect(page.locator('#ra-view')).toContainText('Manual logging');
  await expect(page.locator('#ra-view')).toContainText('Never logged');
  await page.locator('#fl-limit-add').click();
  await page.getByLabel('Material code').fill(a.materialCode);
  await page.getByLabel('Max °C (blank if none)').fill('25');
  await page.getByLabel('Source (SDS section, supplier spec or CoA)').fill('Walk: supplier SDS section 7');
  await page.getByRole('button', { name: 'Save limit' }).click();
  await shot(page, '07-temperatures-zone-set-up-manual');

  // Stores logs the room thermometer: 31 °C
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Temperatures');
  const zone = page.locator(`form[data-zone]`, { hasText: zoneCode });
  await zone.locator('input[name="t"]').fill('31');
  await zone.locator('input[name="n"]').fill('Walk: door left open');
  await zone.getByRole('button', { name: 'Log reading' }).click();
  await expect(page.locator(`form[data-zone]`, { hasText: zoneCode })).toContainText('1 lot(s) on hold');
  await expect(page.locator(`form[data-zone]`, { hasText: zoneCode })).toContainText('31.00 °C');
  await shot(page, '08-excursion-logged-lots-on-hold');
  expect(sql(`select source from inventory.lot_hold where subject_id='${held.rmBatchId}' and released_dt is null`)).toBe('TEMP_EXCURSION');
  expect(sql(`select count(*) from inventory.lot_hold where subject_id='${noLimit.rmBatchId}' and released_dt is null`)).toBe('0');
  expect(sql(`select count(*) from platform.floor_alert where kind='TEMP_EXCURSION' and cleared_at is null and title like '%${zoneCode}%'`)).toBe('1');
  // the held lot is refused at the pick station: the hold reaches the floor
  const j = await job(a.id);
  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Pick');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await scanAtPick(page, j, held.bin, held.barcode);
  await expect(page.locator('#ra-view')).toContainText('LINE STOPPED');
  await expect(page.locator('#ra-view')).toContainText('Temperature excursion');
  await shot(page, '09-excursion-held-lot-stops-pick');
});
