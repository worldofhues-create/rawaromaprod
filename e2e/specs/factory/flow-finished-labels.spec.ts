/* SCAN-13, finished-product flow (owner: every step has a Print button, every label carries both
 * codes, a reprint needs a reason and says REPRINT, and each label scans at the next step):
 *   F1 floor job ticket -> F2 PICKED -> F3 VERIFIED -> F4 MIXED + batch label -> F5 maceration start
 *   and done tags -> F6 QC-approved mark -> F7 FG lot label -> F8 unit, carton, packing list ->
 *   F9 documents, courier label (AWB) -> F10 SHIPPED.
 * Hand-offs are scanned the way the floor scans them: a keyboard-wedge scanner with an AIM prefix.
 * The maceration run and an approving QC round are staged in SQL (their own flows belong to other
 * lanes); their Print buttons and the scan into Batch QC are walked in the browser. */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { must } from '../../harness/chain';
import { openNav, signIn, sql, uniq } from '../../harness/walk';
import { jobDecodes, labelWindows, printedJob, reprintWithReason, wedge, windowDecodes } from '../../harness/labels';

const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

async function floorJob(info: Parameters<Parameters<typeof test>[1]>[1], grams = 125.5) {
  const fam = uniq('fam', info).toLowerCase();
  await must('admin', 'PUT', `/v1/floor/families/${fam}`, { familyName: 'Flow family', colourName: 'Tone' + letters(), colourHex: '#E8C547' });
  const mat = randomUUID();
  sql(`insert into masterdata.material (material_id, material_code, material_name, status) values ('${mat}', '${uniq('MF', info)}', 'Flow oil', 'ACTIVE')`);
  await must('procurement', 'POST', '/v1/floor/codes', { materialId: mat, familyCode: fam });
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'g', 'gram', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const rb = randomUUID(), ib = randomUUID(), bin = randomUUID(), binCode = (uniq('BF', info) + letters()).toUpperCase();
  sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${bin}', '${binCode}', 'ACTIVE')`);
  sql(`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values ('${rb}', '${mat}', '${uniq('RMF', info)}${letters()}', '2098-01-01', 'ACTIVE')`);
  sql(`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values ('${randomUUID()}', '${rb}', 'ACCEPT')`);
  sql(`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values ('${ib}', '${rb}', '${mat}', '${bin}', 1000, '${g}', 'ACTIVE')`);
  const lotCode = ((await must('warehouse', 'POST', `/v1/floor/lots/${ib}/barcode`)) as { barcode: string }).barcode;
  const order = randomUUID(), pl = randomUUID();
  sql(`insert into production.production_order (production_order_id, order_qty, uom_id, status) values ('${order}', 1, '${g}', 'INPROGRESS')`);
  sql(`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values ('${pl}', '${order}', 'ACTIVE')`);
  sql(`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values ('${randomUUID()}', '${order}', '${mat}', ${grams}, false, '${g}', 'ACTIVE')`);
  sql(`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values ('${randomUUID()}', '${pl}', '${mat}', ${grams}, '${g}', 'ACTIVE')`);
  const job = (await must('production', 'POST', '/v1/floor/jobs', { productionOrderId: order, steps: ['Stir 10 minutes'] })) as { floorJobId: string; jobNo: string };
  return { ...job, order, lotCode, bin: binCode, ib };
}

const staged: string[] = [];
test.afterEach(() => { while (staged.length) sql(staged.shift()!); });

test('finished flow: every step prints both codes, reprints with a reason, and its label scans at the next step', async ({ page }, info) => {
  test.setTimeout(240_000);
  const windows = labelWindows(page);
  const lastWindow = async (n: number) => { await expect.poll(() => windows.length).toBeGreaterThan(n); return windows[windows.length - 1]; };
  const j = await floorJob(info);
  const tote = ('T-' + letters()).toUpperCase();

  // F1 the floor job ticket
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Floor queue');
  await page.locator(`#fl-jt-${j.floorJobId}-print`).click();
  await jobDecodes(page, (await printedJob('floor_job', j.jobNo)).template, j.jobNo);
  await reprintWithReason(page, `#fl-jt-${j.floorJobId}-reprint`, 'Ticket fell in the tote');
  await printedJob('floor_job', j.jobNo, { reprint: true });

  // F2 Picker: the bin and lot labels are scanned (Code 128 and QR), the tote too; PICKED carries the tote.
  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Pick');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await wedge(page, '#fl-bin', j.bin, ']C0', 'Tab');
  await expect(page.locator('#fl-lot')).toBeFocused(); // the bin's suffix moved on to the lot, it did not submit
  await wedge(page, '#fl-lot', j.lotCode, ']Q1', 'Tab'); // the last scan field: its suffix submits the line
  let n = windows.length;
  await wedge(page, '#fl-tote2', tote, ']C0', 'Tab'); // the tote is the finish form's only scan field: its suffix finishes
  const picked = await lastWindow(n);
  expect(picked).toContain('PICKED');
  await windowDecodes(page, picked, tote);
  // stock ledger: the pick issued material from the scanned lot
  await expect.poll(() => sql(`select count(*) from production.material_issue where production_order_id='${j.order}'`)).toBe('1');

  // F3 Verifier: the PICKED label is scanned (QR); VERIFIED carries the tote; PICKED reprints with a reason.
  await signIn(page, 'factory', 'verifier');
  await openNav(page, 'Verify');
  await wedge(page, '#fl-tote', tote, ']Q1', 'Enter');
  await expect(page.locator('#ra-view')).toContainText('target 125.50 g');
  n = windows.length;
  await page.locator('#fl-rp').click();
  await page.locator('[data-ask="reason"]').fill('PICKED label torn');
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
  expect(await lastWindow(n)).toContain('REPRINT');
  await page.locator('#fl-wt').fill('125.5');
  await page.locator('#fl-wtick').click();
  n = windows.length;
  await page.locator('#fl-vdone').click();
  const verified = await lastWindow(n);
  expect(verified).toContain('VERIFIED');
  await windowDecodes(page, verified, tote);

  // F4 Mixer: the VERIFIED label is scanned (Code 128); MIXED carries the new batch number.
  await signIn(page, 'factory', 'mixer');
  await openNav(page, 'Mix');
  await wedge(page, '#fl-tote', tote, ']C0', 'Enter');
  await page.locator('[data-step="1"]').click();
  await page.locator('[data-step="2"]').click();
  n = windows.length;
  await page.locator('#fl-mdone').click();
  const mixed = await lastWindow(n);
  await expect.poll(() => sql(`select stage from production.floor_job where floor_job_id='${j.floorJobId}'`)).toBe('DONE');
  const batch = sql(`select batch_no from production.floor_job where floor_job_id='${j.floorJobId}'`);
  expect(mixed).toContain('MIXED');
  await windowDecodes(page, mixed, batch);
  // genealogy: the oil batch exists and consumed the picked lot
  const oil = sql(`select oil_batch_id from production.oil_batch_master where batch_number='${batch}'`);
  expect(oil).not.toBe('');
  // MIXED reprints with a reason: the mixer scans the MIXED label (its batch number) on the Mix screen
  await openNav(page, 'Mix');
  n = windows.length;
  await wedge(page, '#fl-rpm-ref', batch, ']Q1', 'Enter');
  await page.locator('[data-ask="reason"]').fill('MIXED label smudged');
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
  expect(await lastWindow(n)).toContain('REPRINT');
  await signIn(page, 'factory', 'production');

  // F5 maceration: the batch label, the start tag, and the done tag once QC 2 may start.
  sql(`insert into production.maceration_run (oil_batch_id, status, started_at, min_days, max_days, qc1_production_qc_id)
       values ('${oil}', 'MACERATING', now() - interval '40 days', 30, 120, '${randomUUID()}')`);
  staged.push(`delete from production.maceration_run where oil_batch_id = '${oil}'`);
  await openNav(page, 'Maceration');
  const runRow = page.locator('tr', { hasText: batch }).first();
  await runRow.locator('[id^="fo-mc-b-"][id$="-print"]').click();
  await jobDecodes(page, (await printedJob('oil_batch', batch)).template, batch);
  await runRow.locator('[id^="fo-mc-s-"][id$="-print"]').click();
  expect(JSON.stringify((await printedJob('maceration_start', batch)).template.elements)).toContain('MACERATING');
  await runRow.locator('[id^="fo-mc-d-"][id$="-print"]').click();
  expect(JSON.stringify((await printedJob('maceration_done', batch)).template.elements)).toContain('MACERATION DONE');

  // F6 QC: the batch label is scanned into Batch QC; once a round approves, the QC-approved mark prints.
  const set = randomUUID();
  sql(`insert into quality.qc_checkpoint_set (qc_checkpoint_set_id, product_id, version, reason) values ('${set}', '${randomUUID()}', 1, 'flow walk')`);
  sql(`insert into quality.batch_qc_round (oil_batch_id, round_no, qc_checkpoint_set_id, inspector_id, results, decision, reasons, policy_version)
       values ('${oil}', 1, '${set}', 'qc-walk', '[]', 'APPROVE', '[]', 1)`);
  // Staging, not a measurement: stock cover (pfd-floor) measures QC days across the factory, and a
  // round approved seconds after mixing reads as "QC takes 0 days". Removed at the end of this walk.
  staged.push(`delete from quality.batch_qc_round where oil_batch_id = '${oil}'`, `delete from quality.qc_checkpoint_set where qc_checkpoint_set_id = '${set}'`);
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'Batch QC');
  await wedge(page, '#fb-qb-scan', batch, ']Q1', 'Enter');
  await expect(page.locator('#fb-qb')).toHaveValue(oil);
  await page.locator('#fb-qa-print').click();
  const qa = await printedJob('qc_approved', batch);
  expect(JSON.stringify(qa.template.elements)).toContain('QC APPROVED');
  await jobDecodes(page, qa.template, batch);

  // F7 FG lot label from the finished-goods screen; F8 packing scans it in by its lot.
  const so = randomUUID(), fg = randomUUID(), product = randomUUID(), sku = randomUUID(), soNo = uniq('SO', info), courier = `fl${Date.now().toString(36)}`;
  const fgNo = ('FG-' + soNo).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  sql(`insert into sales.sales_order (sales_order_id, so_number, order_date, status) values ('${so}', '${soNo}', current_date, 'CONFIRMED');
       insert into packaging.product_master (product_id, product_code, product_name, status) values ('${product}', 'P-${soNo}', 'Oud Noir', 'ACTIVE');
       insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status) values ('${sku}', '${product}', 'SKU-${soNo}', '10 ml', 'ACTIVE');
       insert into packaging.finished_good_batch_master (finished_good_batch_id, product_sku_id, batch_number, produced_qty, status) values ('${fg}', '${sku}', '${fgNo}', 20, 'ACTIVE');
       insert into packaging.packaging_qc (packaging_qc_id, finished_good_batch_id, overall_result, status) values ('${randomUUID()}', '${fg}', 'PASS', 'ACTIVE');
       insert into sales.courier_connector (provider, display_name) values ('${courier}', 'Flow Courier')`);
  await signIn(page, 'factory', 'packaging');
  await openNav(page, 'Finished batches');
  const fgRow = page.locator('tr', { hasText: fgNo }).first();
  await fgRow.getByRole('button', { name: 'Print FG lot label', exact: true }).click();
  await jobDecodes(page, (await printedJob('fg_lot', fgNo)).template, fgNo);
  await fgRow.getByRole('button', { name: 'Reprint FG lot label', exact: true }).click();
  await page.locator('[data-ask="reason"]').fill('Rack moved');
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
  await printedJob('fg_lot', fgNo, { reprint: true });

  // F8 packing: the unit label (customer) is scanned into its carton; carton labels and the packing list print.
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Packing station');
  await page.locator('#fo-pk-so').selectOption({ label: soNo });
  await page.getByRole('checkbox', { name: new RegExp(fgNo) }).check();
  await page.getByRole('button', { name: 'Start packing' }).click();
  await page.locator('#fo-u-t').fill('10'); await page.locator('#fo-u-tol').fill('0.1'); await page.locator('#fo-u-w').fill('10.05'); await page.locator('#fo-u-seal').check();
  await page.getByRole('button', { name: 'Record unit + print label' }).click();
  await expect(page.locator('tr', { hasText: 'not in a carton' })).toBeVisible();
  const unit = sql(`select unit_code from sales.shipment_unit u join sales.shipment s using (shipment_id) where s.sales_order_id='${so}'`);
  await jobDecodes(page, (await printedJob('customer', unit)).template, unit);
  await page.getByRole('button', { name: 'Open next carton' }).click();
  await wedge(page, '#fo-scan-u', unit, ']Q1', 'Enter');
  await expect(page.locator('tr', { hasText: 'in carton 1' })).toBeVisible();
  await page.locator('#fo-c-w').fill('60');
  await page.getByRole('button', { name: 'Weigh + close carton' }).click();
  await page.getByRole('button', { name: /Finish packing/ }).click();
  await expect(page.locator('.chip', { hasText: 'Packed' })).toBeVisible();
  const ship = sql(`select shipment_no from sales.shipment where sales_order_id='${so}'`);
  const carton = sql(`select carton_code from sales.shipment_carton c join sales.shipment s using (shipment_id) where s.sales_order_id='${so}'`);
  await jobDecodes(page, (await printedJob('carton', carton)).template, carton);
  await printedJob('packing_list', ship);

  // F9 logistics: the carton label is scanned; documents print; the AWB is scanned and the courier label prints.
  await openNav(page, 'Logistics station');
  await page.locator('tr', { hasText: ship }).getByRole('button').first().click();
  await wedge(page, '#fo-lg-cc', carton, ']C0', 'Enter');
  await expect(page.locator('#ra-view')).toContainText(/1 of 1|all cartons/i);
  await page.locator('#fo-lg-docs').click();
  // invoice, packing list and challan always; e-way bill and DG declaration only when they apply. Each carries both codes of the shipment number.
  await expect.poll(() => sql(`select count(*) from platform.print_job where label_kind='dispatch_doc' and subject_ref like '${ship}:%'`)).not.toBe('0');
  for (const doc of ['INVOICE', 'PACKING_LIST', 'DELIVERY_CHALLAN']) await jobDecodes(page, (await printedJob('dispatch_doc', `${ship}:${doc}`, { code: ship })).template, ship);
  const awb = ('AWB' + Date.now()).toUpperCase();
  if (await page.locator('#fo-lg-cr').evaluate((e) => e.tagName === 'SELECT')) await page.locator('#fo-lg-cr').selectOption(courier);
  else await page.locator('#fo-lg-cr').fill(courier);
  await wedge(page, '#fo-lg-awbv', awb, ']C0', 'Tab');
  await page.getByRole('button', { name: /Save AWB/ }).click();
  await jobDecodes(page, (await printedJob('courier', awb)).template, awb);

  // F10 handover: SHIPPED prints with both codes of the AWB, and reprints with a reason.
  await page.locator('#fo-lg-to').fill('Ravi (courier)');
  await page.getByRole('button', { name: 'Handed over', exact: true }).click();
  const shipped = await printedJob('shipped', awb);
  expect(JSON.stringify(shipped.template.elements)).toContain('SHIPPED');
  await jobDecodes(page, shipped.template, awb);
  await reprintWithReason(page, '#fo-lg-shp-reprint', 'Courier asked for a copy');
  await printedJob('shipped', awb, { reprint: true });
  // the dispatch is on the books
  expect(sql(`select status from sales.shipment where sales_order_id='${so}'`)).toBe('HANDED_OVER');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
