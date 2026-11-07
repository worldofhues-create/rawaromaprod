/* SCAN-13, raw inventory flow (owner: every step has a Print button, every label carries both codes,
 * a reprint needs a reason and says REPRINT, and each label scans at the next step). Walked in the
 * browser by the role that owns each step:
 *   R1 PO -> R2 gate entry -> R3 receiving audit -> R4 GRN (line decisions on it) -> R5 incoming QC
 *   tag -> R6 putaway raw-lot label + bin label -> R7 bin label -> R9 hold tag.
 * R8 (lot split / partial return, a child lot) has no screen, endpoint or table in RawProd: it is an
 * owner decision, not a missing button, so it is not walked here. */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { master, must, receivedLot } from '../../harness/chain';
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
