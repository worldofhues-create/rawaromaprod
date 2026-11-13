/* SCAN-13, raw inventory flow (owner: every step has a Print button, every label carries both codes,
 * a reprint needs a reason and says REPRINT, and each label scans at the next step). Walked in the
 * browser by the role that owns each step:
 *   R1 PO -> R2 gate entry -> R3 receiving audit -> R4 GRN (line decisions on it) -> R5 incoming QC
 *   tag -> R6 putaway raw-lot label + bin label -> R7 bin label -> R9 hold tag.
 * FLOOR-1 R8 (lot split across two bins, and the verifier's leftover back to stock) is its own walk
 * below: each makes a child lot with its own L- code and label, in the genealogy, ledger balanced. */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { master, must, receivedLot, signedTypedE2e } from '../../harness/chain';
import { openNav, signIn, sql, uniq } from '../../harness/walk';
import { jobDecodes, labelWindows, printedJob, reprintWithReason, wedge, windowDecodes } from '../../harness/labels';

const today = () => new Date().toISOString().slice(0, 10);

async function openPo(qty: number) {
  const { mat, vendor } = await master();
  const kg = sql(`select uom_id from platform.uom_master where uom_code = 'KG'`) || (await must('owner', 'POST', '/v1/uoms', { uomCode: 'KG', uomName: 'Kilogram' })).uomId;
  const po = await must('procurement', 'POST', '/v1/purchase-orders', { vendorId: vendor, orderDate: today(), items: [{ materialId: mat, orderedQty: qty, uomId: kg, rate: 120, amount: 120 * qty }] });
  const id = po.purchaseOrder.purchaseOrderId as string;
  await must('owner', 'POST', `/v1/purchase-orders/${id}/approve`, { remarks: 'ok' });
  await must('procurement', 'POST', `/v1/purchase-orders/${id}/issue`, {});
  const g = await must('receiving', 'POST', '/v1/gate-entries', { vendorId: vendor, purchaseOrderId: id, vehicleNumber: 'MP09SC0001', entryDt: new Date().toISOString() });
  return { id, number: po.purchaseOrder.poNumber as string, gate: g.gateEntry as { gateEntryId: string; gateEntryNumber: string } };
}

/** A generic screen's row action, on the row that shows `text`. */
async function rowAction(page: import('@playwright/test').Page, text: string, action: string) {
  const row = page.locator('tr', { hasText: text }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: action, exact: true }).click();
}

test('raw flow: every step prints both codes, reprints with a reason, and its label scans at the next step', async ({ page }, info) => {
  const windows = labelWindows(page);
  const po = await openPo(10);

  // R1 PO: procurement prints the PO label; reprints it with a reason.
  await signIn(page, 'factory', 'procurement');
  await openNav(page, 'Purchase orders');
  await rowAction(page, po.number, 'Print label');
  const r1 = await printedJob('po', po.number);
  await jobDecodes(page, r1.template, po.number);
  await rowAction(page, po.number, 'Reprint label');
  await page.locator('[data-ask="reason"]').fill('Label torn at the gate');
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
  await printedJob('po', po.number, { reprint: true });

  // R2 gate entry: receiving prints the gate label.
  await signIn(page, 'factory', 'receiving');
  await openNav(page, 'Gate entries');
  await rowAction(page, po.gate.gateEntryNumber, 'Print label');
  await jobDecodes(page, (await printedJob('gate_entry', po.gate.gateEntryNumber)).template, po.gate.gateEntryNumber);

  // R3 receiving audit: the PO label and the gate label SCAN into the audit (wedge, Code 128 and QR).
  await openNav(page, 'Receiving audit');
  await wedge(page, '#fb-po-scan', po.number, ']C0');
  await expect(page.locator('#fb-po')).toHaveValue(po.id);
  await wedge(page, '#fb-gate-scan', po.gate.gateEntryNumber, ']Q1');
  await expect(page.locator('#fb-gate')).toHaveValue(po.gate.gateEntryId);
  await page.locator('#fb-final').check();
  await page.locator('[data-rec="0"]').fill('7000'); // 30% short at PO close: a partial accept, line rejected
  await page.locator('#fb-rsave').click();
  await expect(page.getByText('Reject line')).toBeVisible();

  // R4 GRN: the GRN label carries the line decision; R5 each new lot's QUARANTINE tag.
  const head = (await page.locator('#ra-view').getByText(/· GRN \S+/).first().textContent())!;
  const grn = /GRN (\S+)/.exec(head)![1];
  await page.locator('#fb-grn-print').click();
  const r4 = await printedJob('grn', grn);
  expect(JSON.stringify(r4.template.elements)).toContain('Reject line');
  await jobDecodes(page, r4.template, grn);
  await reprintWithReason(page, '#fb-grn-reprint', 'Driver needs a copy');
  await printedJob('grn', grn, { reprint: true });
  const qLots = await page.locator('[id^="fb-q-"][id$="-print"]').count();
  if (qLots) {
    await page.locator('#fb-q-0-print').click();
    const qno = (await page.locator('#fb-q-0-print').locator('xpath=ancestor::p[1]/span[1]').textContent())!.trim();
    const q = await printedJob('rm_lot', qno);
    expect(JSON.stringify(q.template.elements)).toContain('QUARANTINE');
  }

  // R5 incoming QC on a received lot: QUARANTINE tag before the decision, QC RELEASED after.
  const lot = await receivedLot(2);
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'Test queue');
  await rowAction(page, lot.batchNumber, 'Print label');
  expect(JSON.stringify((await printedJob('qc_tag', lot.batchNumber)).template.elements)).toContain('QUARANTINE');
  const { qcParam } = await master();
  await must('qc', 'POST', `/v1/qc-inspections/${lot.insp}/results`, { results: [{ qcParameterId: qcParam, observedValue: 1.47, result: 'PASS' }] });
  await must('qc', 'POST', '/v1/qc-sample-retentions', { qcInspectionId: lot.insp, rmBatchId: lot.rmBatch, sampleCode: `RS-${lot.batchNumber}`, retainedDt: new Date().toISOString() }); // FLOOR-QC-IN-1: the sample drawn and kept
  await must('qc', 'POST', `/v1/qc-inspections/${lot.insp}/disposition`, { dispositionCode: 'ACCEPT', dispositionReason: 'within spec' });
  await page.reload(); await openNav(page, 'Test queue');
  await rowAction(page, lot.batchNumber, 'Print label');
  const r5 = await printedJob('qc_tag', lot.batchNumber);
  expect(JSON.stringify(r5.template.elements)).toContain('QC RELEASED');
  // stock ledger: the accepted lot is on the warehouse's books
  await expect.poll(() => sql(`select count(*) from inventory.inventory_batch where rm_batch_id = '${lot.rmBatch}'`)).not.toBe('0');

  // R6 putaway: the QC tag SCANS into Lot hold & recall; raw-lot label (both codes, L- id) + bin label.
  const binId = randomUUID(), bin = ('B-' + uniq('S', info)).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  sql(`insert into location.storage_location_master (storage_location_id, storage_location_code, status) values ('${binId}', '${bin}', 'ACTIVE')`);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Lot hold & recall');
  await wedge(page, '#fb-lot', lot.batchNumber, ']Q1', 'Tab');
  await expect(page.locator('#fb-lot')).toHaveValue(lot.batchNumber);
  await wedge(page, '#fb-bin', bin, ']C0', 'Tab');
  const before = windows.length;
  await page.locator('#fb-label').click();
  await expect.poll(() => windows.length).toBeGreaterThan(before);
  const l6 = sql(`select payload->>'barcode' from inventory.raw_lot_label where rm_batch_id = '${lot.rmBatch}' order by printed_dt desc limit 1`);
  expect(l6).toMatch(/^L-[0-9A-HJKMNP-TV-Z]{7}$/);
  await windowDecodes(page, windows[windows.length - 1], l6);
  // a second raw-lot label is a REPRINT with a reason
  const beforeRp = windows.length;
  await page.locator('#fb-label-rp').click();
  await page.locator('[data-ask="reason"]').fill('Smudged by solvent');
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
  await expect.poll(() => sql(`select payload->>'reprintReason' from inventory.raw_lot_label where rm_batch_id = '${lot.rmBatch}' order by printed_dt desc limit 1`)).toBe('Smudged by solvent');
  await expect.poll(() => windows.length).toBeGreaterThan(beforeRp);
  expect(windows[windows.length - 1]).toContain('REPRINT');
  // R6/R7 the bin label, both codes, reprint with a reason
  await page.locator('#fb-binlabel').click();
  await jobDecodes(page, (await printedJob('bin', bin)).template, bin);
  await page.locator('#fb-binlabel-rp').click();
  await page.locator('[data-ask="reason"]').fill('Bin relabelled');
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
  await printedJob('bin', bin, { reprint: true });
  // the raw-lot label scans at the picker (the next step), under the picker's own permissions
  const asPicker = (await must('picker', 'GET', `/v1/floor/scan?code=${encodeURIComponent(']C0' + l6)}`)) as Record<string, unknown>;
  expect(asPicker.barcode).toBe(l6);
  expect(asPicker.materialName).toBeUndefined();

  // R9 hold: the hold tag (both codes) on the held lot; scanning it reads ON HOLD at recall review.
  await page.locator('#fb-hold').click();
  await page.locator('[data-ask="reason"]').fill('Walk: suspect lot');
  await page.getByRole('button', { name: 'Hold lot', exact: true }).click();
  await expect(page.getByText('Walk: suspect lot').first()).toBeVisible();
  const heldRow = page.locator('tr', { hasText: lot.batchNumber }).first();
  await heldRow.locator('[id^="fb-ht-"][id$="-print"]').click();
  const r9 = await printedJob('hold_tag', lot.batchNumber);
  expect(JSON.stringify(r9.template.elements)).toContain('ON HOLD');
  await jobDecodes(page, r9.template, lot.batchNumber);
  expect(sql(`select count(*) from inventory.lot_hold where subject_id = '${lot.rmBatch}' and released_dt is null`)).toBe('1');
  await wedge(page, '#fb-lot', lot.batchNumber, ']C0', 'Tab');
  await page.locator('#fb-trace').click();
  await expect(page.getByText(`Lot ${lot.batchNumber} · ON HOLD`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

/* ── FLOOR-1: R8 lot split and partial return ───────────────────────────────────────────────── */

const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const L = /^L-[0-9A-HJKMNP-TV-Z]{7}$/;
// Stock (FEFO) lists the earliest expiry first, so a near date keeps this lot on the first page.
const EXPIRY = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);

/** A released raw lot of 1000 g in a bin, a material with a floor code, and a floor job needing 125.5 g. */
async function stagedJob(info: Parameters<Parameters<typeof test>[1]>[1]) {
  const fam = uniq('fsp', info).toLowerCase();
  await must('admin', 'PUT', `/v1/floor/families/${fam}`, { familyName: 'Split family', colourName: 'Tone' + letters(), colourHex: '#8B5A2B' });
  const mat = randomUUID();
  sql(`insert into masterdata.material (material_id, material_code, material_name, status) values ('${mat}', '${uniq('MS', info)}', 'Split oil', 'ACTIVE')`);
  await must('procurement', 'POST', '/v1/floor/codes', { materialId: mat, familyCode: fam });
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'g', 'gram', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const bin = () => { const id = randomUUID(), code = (uniq('BS', info) + letters()).toUpperCase(); sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${id}', '${code}', 'ACTIVE')`); return code; };
  const home = bin();
  const rb = randomUUID(), ib = randomUUID(), lotNo = `${uniq('RMS', info)}${letters()}`;
  sql(`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values ('${rb}', '${mat}', '${lotNo}', '${EXPIRY}', 'ACTIVE')`);
  sql(`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values ('${randomUUID()}', '${rb}', 'ACCEPT')`);
  sql(`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status)
       select '${ib}', '${rb}', '${mat}', bin_id, 1000, '${g}', 'ACTIVE' from location.bin_master where bin_code = '${home}'`);
  const lotCode = ((await must('warehouse', 'POST', `/v1/floor/lots/${ib}/barcode`)) as { barcode: string }).barcode;
  const order = randomUUID(), pl = randomUUID();
  sql(`insert into production.production_order (production_order_id, order_qty, uom_id, status) values ('${order}', 1, '${g}', 'INPROGRESS')`);
  sql(`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values ('${pl}', '${order}', 'ACTIVE')`);
  sql(`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values ('${randomUUID()}', '${order}', '${mat}', 125.5, false, '${g}', 'ACTIVE')`);
  sql(`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values ('${randomUUID()}', '${pl}', '${mat}', 125.5, '${g}', 'ACTIVE')`);
  const job = (await must('production', 'POST', '/v1/floor/jobs', { productionOrderId: order, steps: ['Stir 10 minutes'] })) as { floorJobId: string; jobNo: string };
  return { ...job, ib, rb, lotNo, lotCode, home, bin };
}
const childOf = (parentIb: string, kind: string) => sql(`select lb.barcode from inventory.lot_split ls join inventory.lot_barcode lb on lb.inventory_batch_id = ls.child_inventory_batch_id
  where ls.parent_inventory_batch_id = '${parentIb}' and ls.kind = '${kind}' order by ls.created_dt desc limit 1`);
const onHandOf = (code: string) => sql(`select ib.quantity_on_hand from inventory.lot_barcode lb join inventory.inventory_batch ib using (inventory_batch_id) where lb.barcode = '${code}'`);
const ledgerSum = (childCode: string) => sql(`select coalesce(sum(t.transaction_qty), -1)::numeric(18,4) from inventory.inventory_transaction t
  where t.reference_document_id = (select ls.lot_split_id from inventory.lot_split ls join inventory.lot_barcode lb on lb.inventory_batch_id = ls.child_inventory_batch_id where lb.barcode = '${childCode}')`);

test('R8: a lot splits across two bins from Stock, and the verifier\'s leftover comes back: child lots with their own codes, labels, reprints and genealogy', async ({ page }, info) => {
  test.setTimeout(180_000);
  const windows = labelWindows(page);
  const lastWindow = async (n: number) => { await expect.poll(() => windows.length).toBeGreaterThan(n); return windows[windows.length - 1]; };
  const j = await stagedJob(info);

  // S1 Stock on hand (FEFO): warehouse splits 100 g of the lot into another bin. The child prints its own label.
  const binB = j.bin();
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Stock on hand');
  await rowAction(page, j.lotNo, 'Split lot');
  await page.locator('[data-ask="qty"]').fill('100');
  await page.locator('[data-ask="bin"]').fill(binB);
  let n = windows.length;
  await page.getByRole('button', { name: 'Split and print', exact: true }).click();
  const splitLabel = await lastWindow(n);
  const c1 = childOf(j.ib, 'SPLIT');
  expect(c1).toMatch(L);
  expect(c1).not.toBe(j.lotCode);
  expect(splitLabel).toContain('RAW LOT · SPLIT');
  expect(splitLabel).toContain(j.lotCode); // From: the parent
  expect(splitLabel).toContain(j.lotNo); // the parent's lot number
  expect(splitLabel).toContain(EXPIRY); // the parent's expiry (FEFO keeps it)
  expect(splitLabel).toContain('Classification pending');
  await windowDecodes(page, splitLabel, c1);
  // the stock ledger balances to the mg: the parent lost exactly what the child holds
  expect(onHandOf(j.lotCode)).toBe('900.0000');
  expect(onHandOf(c1)).toBe('100.0000');
  expect(ledgerSum(c1)).toBe('0.0000');
  // the child scans like any lot, under the picker's own permissions, with the parent's expiry
  const asPicker = (await must('picker', 'GET', `/v1/floor/scan?code=${encodeURIComponent(']Q1' + c1)}`)) as Record<string, unknown>;
  expect([asPicker.expiry, asPicker.lot, asPicker.splitFrom, asPicker.pickable]).toEqual([EXPIRY, j.lotNo, j.lotCode, true]);

  // The pick (the step before): the picker takes the lot FEFO directs (the 100 g child is too small for 125.5 g).
  const tote = ('T-' + letters()).toUpperCase();
  const pv = (await must('picker', 'GET', `/v1/floor/jobs/${j.floorJobId}/pick`)) as { lines: Array<{ floorLineId: string; takeLot: { barcode: string; bin: string } }> };
  const take = pv.lines[0]!.takeLot;
  expect(take.barcode).toBe(j.lotCode);
  await must('picker', 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/lines/${pv.lines[0]!.floorLineId}`, { bin: take.bin, barcode: take.barcode });
  await must('picker', 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/complete`, { tote });

  // S2 Verifier: weighs the line, then the leftover goes back: weigh it, scan the lot (QR), scan the bin (Code 128).
  const binC = j.bin();
  await signIn(page, 'factory', 'verifier');
  await openNav(page, 'Verify');
  await wedge(page, '#fl-tote', tote, ']Q1', 'Enter');
  await page.locator('#fl-wt').fill('125.5');
  await page.locator('#fl-wtick').click();
  await expect(page.locator('#fl-vdone')).toBeVisible();
  await page.locator('#fl-lo-wt').fill('774.5');
  await wedge(page, '#fl-lo-lot', j.lotCode, ']Q1', 'Tab');
  await expect(page.locator('#fl-lo-bin')).toBeFocused(); // the lot's suffix moved on to the bin, it did not submit
  n = windows.length;
  await wedge(page, '#fl-lo-bin', binC, ']C0', 'Tab'); // the last scan field: its suffix returns the leftover
  const back = await lastWindow(n);
  const c2 = childOf(j.ib, 'RETURN');
  expect(c2).toMatch(L);
  expect(back).toContain('RAW LOT · RETURNED');
  expect(back).toContain(j.jobNo);
  expect(back).toContain(EXPIRY);
  await windowDecodes(page, back, c2);
  expect(onHandOf(c2)).toBe('774.5000');
  expect(ledgerSum(c2)).toBe('0.0000');
  // once the job's issue is debited (125.5 g), parent + children = the 1000 g received, to the mg
  await expect.poll(() => onHandOf(j.lotCode), { timeout: 20_000 }).toBe('0.0000');
  expect(sql(`select (select sum(ib.quantity_on_hand) from inventory.inventory_batch ib where ib.rm_batch_id = '${j.rb}') + 125.5`)).toBe('1000.0000');
  // the leftover's label reprints from the station with a reason, and says REPRINT
  await expect(page.locator(`[data-lo-rp="${c2}"]`)).toBeVisible();
  n = windows.length;
  await page.locator(`[data-lo-rp="${c2}"]`).click();
  await page.locator('[data-ask="reason"]').fill('Leftover label wet');
  await page.getByRole('button', { name: 'Reprint', exact: true }).last().click();
  expect(await lastWindow(n)).toContain('REPRINT');
  expect(sql(`select reason from inventory.lot_label where barcode = '${c2}' and reprint order by printed_dt desc limit 1`)).toBe('Leftover label wet');
  // a lot not picked on this job is refused at the station, with the reason shown
  await page.locator('#fl-lo-wt').fill('10');
  await page.locator('#fl-lo-lot').fill(c1);
  await page.locator('#fl-lo-bin').fill(binC);
  await page.locator('#fl-lo-go').click();
  await expect(page.locator('#fl-lo-err')).toContainText('not picked on this job');

  // S3 Scan a lot (warehouse): the genealogy reads both ways; the child label reprints with a reason.
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Scan a lot');
  await wedge(page, '#fl-sci', c2, ']C0', 'Enter');
  await expect(page.locator('#fl-geno')).toContainText(`Cut from ${j.lotCode}`);
  await expect(page.locator('#fl-geno')).toContainText('returned from the verifier');
  await expect(page.locator('#fl-geno')).toContainText(j.jobNo);
  await reprintWithReason(page, '#fl-lotrp', 'Moved to a new shelf');
  await expect.poll(() => sql(`select count(*) from inventory.lot_label where barcode = '${c2}' and reprint`)).toBe('2');
  await wedge(page, '#fl-sci', j.lotCode, ']Q1', 'Enter');
  await expect(page.locator('#fl-geno')).toContainText('An original lot');
  await expect(page.locator('#fl-geno')).toContainText(c1);
  await expect(page.locator('#fl-geno')).toContainText(c2);
  expect(sql(`select string_agg(relationship_type, ',' order by created_dt) from inventory.batch_genealogy_history where rm_batch_id = '${j.rb}'`)).toBe('LOT_SPLIT,LOT_RETURN');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

/* LEFTOVER-AFTER-FINISH: the job is DONE and the verify form has gone. The lot's own scan brings the
 * return back, with the same rules. The kiosk walk reaches it from a tablet locked to Verify. */
async function finishedJob(info: Parameters<Parameters<typeof test>[1]>[1]) {
  const j = await stagedJob(info);
  const pv = (await must('picker', 'GET', `/v1/floor/jobs/${j.floorJobId}/pick`)) as { lines: Array<{ floorLineId: string; takeLot: { barcode: string; bin: string } }> };
  const take = pv.lines[0]!.takeLot;
  await must('picker', 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/lines/${pv.lines[0]!.floorLineId}`, { bin: take.bin, barcode: take.barcode });
  await must('picker', 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/complete`, { tote: ('T-' + letters()).toUpperCase() });
  const vv = (await must('verifier', 'GET', `/v1/floor/jobs/${j.floorJobId}/verify`)) as { lines: Array<{ floorLineId: string; targetMg: number }> };
  for (const l of vv.lines) await must('verifier', 'POST', `/v1/floor/jobs/${j.floorJobId}/verify/lines/${l.floorLineId}`, { actualMg: l.targetMg, ...(await signedTypedE2e(l.targetMg)) });
  await must('verifier', 'POST', `/v1/floor/jobs/${j.floorJobId}/verify/complete`, {});
  const mv = (await must('mixer', 'GET', `/v1/floor/jobs/${j.floorJobId}/mix`)) as { steps: Array<{ seq: number }> };
  for (const st of mv.steps) await must('mixer', 'POST', `/v1/floor/jobs/${j.floorJobId}/mix/steps/${st.seq}`, {});
  await must('mixer', 'POST', `/v1/floor/jobs/${j.floorJobId}/mix/complete`, {});
  await expect.poll(() => onHandOf(j.lotCode), { timeout: 20_000 }).toBe('874.5000');
  return j;
}

async function returnFromScan(page: import('@playwright/test').Page, j: Awaited<ReturnType<typeof finishedJob>>, windows: string[], info: Parameters<Parameters<typeof test>[1]>[1], shot: string) {
  await wedge(page, '#fl-sci', j.lotCode, ']Q1', 'Enter');
  await expect(page.locator('#fl-left')).toContainText('At most 874.5 g');
  await expect(page.locator('#fl-left')).toContainText(j.jobNo);
  await expect(page.locator('#fl-left')).toContainText('finished');
  await page.screenshot({ path: info.outputPath(`${shot}-offer.png`), fullPage: true });
  // over the cap: refused, with the reason on the sheet, and nothing moved
  const binD = j.bin();
  await page.locator('[data-left]').first().click();
  await page.locator('[data-ask="qty"]').fill('874.501');
  await page.locator('[data-ask="bin"]').fill(binD);
  await page.getByRole('button', { name: 'Return and print', exact: true }).click();
  await expect(page.getByText('At most 874.5 g can come back').first()).toBeVisible();
  expect(onHandOf(j.lotCode)).toBe('874.5000');
  await page.locator('[data-ask="qty"]').fill('800');
  await page.screenshot({ path: info.outputPath(`${shot}-sheet.png`) });
  const n = windows.length;
  await page.getByRole('button', { name: 'Return and print', exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThan(n);
  const back = windows[windows.length - 1]!;
  const child = childOf(j.ib, 'RETURN');
  expect(child).toMatch(L);
  expect(back).toContain('RAW LOT · RETURNED');
  expect(back).toContain(j.jobNo);
  expect(back).toContain(EXPIRY);
  await windowDecodes(page, back, child);
  expect(onHandOf(child)).toBe('800.0000');
  expect(onHandOf(j.lotCode)).toBe('74.5000');
  expect(ledgerSum(child)).toBe('0.0000');
  // the scan reloads: the cap has come down and the genealogy names the child
  await expect(page.locator('#fl-left')).toContainText('At most 74.5 g');
  await expect(page.locator('#fl-geno')).toContainText(child);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  return child;
}

test('leftover after Finish: Scan a lot returns it as a child lot; the picker cannot; the child reprints', async ({ page }, info) => {
  test.setTimeout(180_000);
  const windows = labelWindows(page);
  const j = await finishedJob(info);
  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Scan a lot');
  await wedge(page, '#fl-sci', j.lotCode, ']Q1', 'Enter');
  await expect(page.locator('#fl-geno')).toContainText('An original lot');
  await expect(page.locator('[data-left]')).toHaveCount(0); // the picker holds no verify permission: no offer at all
  await signIn(page, 'factory', 'verifier');
  await openNav(page, 'Scan a lot');
  const child = await returnFromScan(page, j, windows, info, 'rail');
  await wedge(page, '#fl-sci', child, ']C0', 'Enter');
  await reprintWithReason(page, '#fl-left-rp', 'Label wet at the bin');
  await expect.poll(() => sql(`select count(*) from inventory.lot_label where barcode = '${child}' and reprint`)).toBe('1');
});

test('leftover after Finish: a tablet locked to Verify reaches it without leaving the kiosk', async ({ page }, info) => {
  test.setTimeout(180_000);
  const windows = labelWindows(page);
  const j = await finishedJob(info);
  await page.addInitScript(() => { try { localStorage.setItem('ra.kiosk', JSON.stringify({ station: 'Verify 1', screen: 'floorverify', deviceId: 'walk' })); } catch (e) { /* about:blank */ } });
  await signIn(page, 'factory', 'verifier');
  await expect(page.locator('html')).toHaveClass(/ra-kiosk/);
  await page.locator('#fl-left-scan').click();
  await returnFromScan(page, j, windows, info, 'kiosk');
  const small = await page.locator('[data-left], #fl-scgo').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight < 56).length);
  expect(small).toBe(0); // gloved hands: the 56 px floor
});
