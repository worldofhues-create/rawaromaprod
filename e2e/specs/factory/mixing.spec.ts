/* Factory: mixing, weighing, oil batches. */
import { expect, test } from '@playwright/test';
import { master, orderWithIssuedStock } from '../../harness/chain';
import { confirmDialog, createViaForm, expectRefused, openNav, rowById, signIn, sql, uniq } from '../../harness/walk';

test('compounding opens a session, weighs, ends it and records the oil batch; it all reads back', async ({ page }, info) => {
  await master();
  const { order, qty } = await orderWithIssuedStock(3);
  const batch = uniq('OB-', info);
  await signIn(page, 'factory', 'compounding');
  await openNav(page, 'Mixing sessions');
  await createViaForm(page, { productionOrderId: order });
  const session = sql(`select secure_mixing_session_id from production.secure_mixing_session where production_order_id='${order}'`);
  expect(session).not.toBe('');
  await rowById(page, session).getByRole('button', { name: 'Record weighing', exact: true }).click();
  await page.getByLabel('Ingredient line number').fill('1');
  await page.getByLabel('Gross reading').fill(String(qty + 0.45));
  await page.getByLabel('Tare reading').fill('0.45');
  await page.getByRole('button', { name: 'Save weighing', exact: true }).click();
  await expect.poll(() => sql(`select status from production.weighing_record where secure_mixing_session_id='${session}'`), { timeout: 20_000 }).toBe('ACCEPTED');
  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Mixing sessions');
  await rowById(page, session).getByRole('button', { name: 'End session', exact: true }).click();
  await confirmDialog(page, 'End session');
  await expect.poll(() => sql(`select status from production.secure_mixing_session where secure_mixing_session_id='${session}'`), { timeout: 20_000 }).toBe('COMPLETED');

  await openNav(page, 'Oil batches');
  await createViaForm(page, { productionOrderId: order, batchNumber: batch, producedQty: qty });
  await expect(page.locator('#ra-results')).toContainText(batch);
  expect(sql(`select count(*) from production.oil_batch_master where batch_number='${batch}'`)).toBe('1');
  await page.reload();
  await expect(page.locator('#ra-results')).toContainText(batch);
});

test('production oversight may read a weighing but not record one', async ({ page }) => {
  await signIn(page, 'factory', 'production');
  await expect(page.locator('#ra-side .who small')).toHaveText('Production');
  await expectRefused(page, 'POST', '/v1/mixing-sessions/00000000-0000-0000-0000-000000000000/weighings', { sequenceNo: 1, grossQty: 1, tareQty: 0 });
});
