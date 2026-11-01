/* Factory: finished goods, labels, reservations. */
import { expect, test } from '@playwright/test';
import { filledPackageOrder, master, releasedCoa, sku, releasedFinishedBatch } from '../../harness/chain';
import { createViaForm, expectRefused, fillForm, openNav, rowAction, signIn, sql, uniq } from '../../harness/walk';

test('packaging records a finished batch and labels it; packaging QC cannot pass before the label', async ({ page }, info) => {
  const fg = uniq('FG-', info);
  await master(); await sku();
  const { pkg, oil } = await filledPackageOrder(`OB-${fg}`, 2);
  await signIn(page, 'factory', 'packaging');
  await openNav(page, 'Finished batches');
  await createViaForm(page, { packageOrderId: pkg, productSkuId: { label: 'CH-SKU-1' }, batchNumber: fg, producedQty: 2, manufacturingDate: '2031-01-01', expiryDate: '2033-01-01' });
  await expect(page.locator('#ra-results')).toContainText(fg);
  expect(sql(`select count(*) from packaging.finished_good_batch_master where batch_number='${fg}'`)).toBe('1');
  await openNav(page, 'Packaging QC');
  await page.locator('#ra-new').click();
  await fillForm(page, { finishedGoodBatchId: { label: fg }, leakageCheck: 'PASS', labelCheck: 'PASS', cartonCheck: 'PASS' });
  await page.locator('#ra-msave').click();
  await expect(page.locator('#ra-merr'), 'the refusal reaches the screen').toContainText(/label/i);
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  await releasedCoa(oil);
  await openNav(page, 'Finished batches');
  await rowAction(page, fg, 'Apply labels');
  await page.locator('#pv-lcount').fill('1');
  await page.getByRole('button', { name: 'Record and print', exact: true }).click();
  await expect(page.locator('.toast').last()).toContainText(/Labels recorded/);
  await expect.poll(() => sql(`select count(*) from packaging.fg_label_record l join packaging.finished_good_batch_master b using (finished_good_batch_id) where b.batch_number='${fg}'`), { timeout: 20_000 }).not.toBe('0');
  await openNav(page, 'Product labels');
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
});

test('a released batch can be reserved on screen and the reservation reads back; filling cannot', async ({ page }, info) => {
  const fg = uniq('FGR-', info);
  const { fg: id } = await releasedFinishedBatch(fg, 2);
  await signIn(page, 'factory', 'packaging');
  await openNav(page, 'Reserved finished stock');
  await createViaForm(page, { finishedGoodBatchId: { label: fg }, reservedQty: 1, channel: 'OFFLINE' });
  expect(sql(`select count(*) from packaging.finished_good_reservation where reserved_qty=1`)).not.toBe('0');
  await page.reload();
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'POST', '/v1/fg-reservations', { finishedGoodBatchId: id, reservedQty: 1 });
});
