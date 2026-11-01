/* Factory: incoming QC, test queue and results. */
import { expect, test } from '@playwright/test';
import { master, receivedLot } from '../../harness/chain';
import { confirmDialog, expectRefused, openNav, rowAction, searchFor, signIn, sql } from '../../harness/walk';

test('QC records a result and accepts; the lot leaves quarantine onto the stock books', async ({ page }) => {
  await master();
  const { batchNumber, rmBatch, insp } = await receivedLot(6);
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'Test queue');
  await searchFor(page, batchNumber);
  await rowAction(page, batchNumber, 'Record results');
  const sheet = page.locator('#ra-cform, .sheet, [role="dialog"]').last();
  await sheet.locator('select').first().selectOption({ label: 'Refractive index' });
  await sheet.locator('input[type="number"]').first().fill('1.47');
  const result = sheet.locator('select').nth(1);
  if (await result.count()) await result.selectOption('PASS');
  await sheet.getByRole('button', { name: /^(Save|Record|Submit)/ }).click();
  await expect.poll(() => sql(`select count(*) from quality.qc_result_details where qc_inspection_id='${insp}'`)).toBe('1');

  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Test queue');
  await searchFor(page, batchNumber);
  await rowAction(page, batchNumber, 'Accept');
  await confirmDialog(page, 'Accept');
  await expect.poll(() => sql(`select status from inventory.rm_batch_master where rm_batch_id='${rmBatch}'`), { timeout: 30_000 }).not.toBe('QUARANTINE');
  await expect.poll(() => sql(`select count(*) from inventory.inventory_batch where rm_batch_id='${rmBatch}'`), { timeout: 30_000 }).toBe('1');
});

test('receiving may not decide a lot it received', async ({ page }) => {
  const { insp } = await receivedLot(1);
  await signIn(page, 'factory', 'receiving');
  await expect(page.locator('#ra-side .who small')).toHaveText('Receiving');
  await expectRefused(page, 'POST', `/v1/qc-inspections/${insp}/disposition`, { dispositionCode: 'ACCEPT', dispositionReason: 'no' });
});
