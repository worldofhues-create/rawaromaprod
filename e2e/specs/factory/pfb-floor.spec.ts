/* PROD-B: the P2 floor screens driven by hand: receiving audit (rule shown, short line rejected, debit
 * note), supplier payments (held until a terms rule exists), QC checkpoints (publish a version), and lot
 * hold & recall (trace a released lot, hold it). Asserted on the screen and in the database. */
import { expect, test, type Page } from '@playwright/test';
import { master, must, releasedStock, sku } from '../../harness/chain';
import { openNav, signIn, sql } from '../../harness/walk';

const today = () => new Date().toISOString().slice(0, 10);

async function kgUom() {
  const id = sql(`select uom_id from platform.uom_master where uom_code = 'KG'`);
  if (id) return id;
  return (await must('owner', 'POST', '/v1/uoms', { uomCode: 'KG', uomName: 'Kilogram' })).uomId as string;
}
async function poInKg(qty: number) {
  const { mat, vendor } = await master();
  const kg = await kgUom();
  const po = await must('procurement', 'POST', '/v1/purchase-orders', { vendorId: vendor, orderDate: today(),
    items: [{ materialId: mat, orderedQty: qty, uomId: kg, rate: 120, amount: 120 * qty }] });
  const id = po.purchaseOrder.purchaseOrderId;
  await must('owner', 'POST', `/v1/purchase-orders/${id}/approve`, { remarks: 'ok' });
  await must('procurement', 'POST', `/v1/purchase-orders/${id}/issue`, {});
  const g = await must('receiving', 'POST', '/v1/gate-entries', { vendorId: vendor, purchaseOrderId: id, vehicleNumber: 'MP09PF0001', entryDt: new Date().toISOString() });
  return { id, number: po.purchaseOrder.poNumber as string, gate: g.gateEntry };
}
async function noSideScroll(page: Page) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(w).toBeLessThanOrEqual(1);
}

test('receiving audit: the rule is shown first; 30% short at PO close rejects the line and raises a debit note', async ({ page }, info) => {
  const { id, number, gate } = await poInKg(10);
  expect(gate.status).not.toBe('HELD');
  await signIn(page, 'factory', 'receiving');
  await openNav(page, 'Receiving audit');
  await page.locator('#fb-po').selectOption(id);
  await expect(page.getByText(/short 20% or more at PO close rejects the short line/)).toBeVisible();
  await page.locator('#fb-gate').selectOption(gate.gateEntryId);
  await page.locator('#fb-final').check();
  await page.locator('[data-rec="0"]').fill('7000');
  await page.locator('[data-ck="0:sealIntact"]').uncheck();
  await page.locator('#fb-rsave').click();
  await expect(page.locator('#fb-rerr')).toContainText('give a reason');
  await page.locator('[data-why="0:sealIntact"]').fill('Tape re-applied by transporter');
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('recv-before.png'), fullPage: true });
  await page.locator('#fb-rsave').click();
  await expect(page.getByText('Reject line')).toBeVisible();
  await expect(page.getByText(/Debit note DN-/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('recv-after.png'), fullPage: true });
  expect(sql(`select l.decision || ' ' || l.rejected_base from inventory.receiving_audit a join inventory.receiving_audit_line l using (receiving_audit_id) where a.purchase_order_id = '${id}'`)).toBe('REJECT_LINE 7000000');
  expect(sql(`select amount_paise from procurement.debit_note where purchase_order_id = '${id}'`)).toBe('120000');
  expect(number).toBeTruthy();
});

test('supplier payments: with no terms rule published, the PO says it is held', async ({ page }) => {
  const { id } = await poInKg(2);
  await signIn(page, 'factory', 'procurement');
  await openNav(page, 'Supplier payments');
  await page.locator('#fb-ppo').selectOption(id);
  await expect(page.getByText(/Held: .*procurement\.payment_terms/)).toBeVisible();
  await noSideScroll(page);
});

test('QC checkpoints: publishing makes version 1, with its reason', async ({ page }, info) => {
  const { product } = await sku();
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'QC checkpoints');
  await page.locator('#fb-cprod').selectOption(product);
  const before = Number(sql(`select count(*) from quality.qc_checkpoint_set where product_id = '${product}'`));
  await page.locator('[data-cprow] [data-f="name"]').first().fill('Odour profile ' + info.project.name);
  await page.locator('[data-cprow] [data-f="critical"]').first().check();
  // PROM-3 (STAGE-2-RP): with the factory rule qc.reference_required on, a set with no comparison to the
  // retained reference is refused in a sentence. The walk published one and waited for "Version 1"; it now
  // reads the refusal, adds the REFERENCE checkpoint a person would, and publishes.
  await page.locator('#fb-cpwhy').fill('Walk ' + info.project.name);
  await page.locator('#fb-cpsave').click();
  await expect(page.locator('#ra-view')).toContainText('add a REFERENCE checkpoint');
  expect(Number(sql(`select count(*) from quality.qc_checkpoint_set where product_id = '${product}'`))).toBe(before);
  await page.locator('#fb-cpadd').click();
  await page.locator('[data-cprow] [data-f="name"]').last().fill('Against the retained reference');
  await page.locator('[data-cprow] [data-f="checkType"]').last().selectOption('REFERENCE');
  await page.locator('#fb-cpwhy').fill('Walk ' + info.project.name);
  await page.locator('#fb-cpsave').click();
  await expect(page.getByText('Version ' + (before + 1), { exact: true })).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('checkpoints.png'), fullPage: true });
});

test('lot hold & recall: a released lot traces, then is held and listed', async ({ page }, info) => {
  const lot = await releasedStock(2);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Lot hold & recall');
  await page.locator('#fb-lot').fill(lot.batchNumber); // WALK2-RP-11: the number on the label, not a uuid
  await page.locator('#fb-trace').click();
  await expect(page.getByText('Lot ' + lot.batchNumber)).toBeVisible();
  await expect(page.getByText(/Shipped orders \(0\)/)).toBeVisible();
  await page.locator('#fb-hold').click();
  await page.locator('[data-ask="reason"]').fill('Walk: suspect lot');
  await page.getByRole('button', { name: 'Hold lot', exact: true }).click();
  await expect(page.getByText('Walk: suspect lot').first()).toBeVisible();
  expect(sql(`select count(*) from inventory.lot_hold where subject_id = '${lot.rmBatch}' and released_dt is null`)).toBe('1');
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('recall.png'), fullPage: true });
});
