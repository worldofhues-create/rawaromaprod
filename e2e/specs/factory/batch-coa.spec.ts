/* Factory: batch COA. */
import { expect, test } from '@playwright/test';
import { master, must, producible, releasedOil, sku } from '../../harness/chain';
import { confirmDialog, expectRefused, openNav, rowAction, signIn, sql, uniq } from '../../harness/walk';

test('QC records a batch certificate from the product spec and releases it; a packer cannot', async ({ page }, info) => {
  await master(); await producible();
  const { product } = await sku();
  const batch = uniq('OBC-', info);
  await releasedOil(batch, 2);
  await must('qc', 'PUT', `/v1/product-qc-specs/${product}`, { sgMin: 0.5, sgMax: 2, flashPointMinC: 20, flashPointMaxC: 120, shelfLifeMonths: 24 });
  await signIn(page, 'factory', 'qc');
  await openNav(page, 'Batch certificates');
  await page.locator('#ra-new').click();
  const b = page.locator('#ra-cb');
  await expect(b.locator('option', { hasText: batch })).toBeAttached();
  await b.selectOption(sql(`select oil_batch_id from production.oil_batch_master where batch_number='${batch}'`));
  await expect(page.locator('#ra-cp option:not([value=""])').first()).toBeAttached();
  await page.locator('#ra-cp').selectOption({ index: 1 });
  await page.locator('#ra-cca').fill('Clear pale liquid');
  await page.locator('#ra-cod').fill('Conforms to standard');
  await page.locator('#ra-csg').fill('1.02');
  await page.locator('#ra-cfp').fill('61.5');
  await page.locator('#ra-csave').click();
  await expect(page.locator('#ra-csave')).toHaveCount(0);
  await expect(page.locator('#ra-results')).toContainText(batch);
  const coa = sql(`select c.batch_coa_id from production.batch_coa c join production.oil_batch_master o on o.oil_batch_id=c.oil_batch_id where o.batch_number='${batch}'`);
  expect(coa).not.toBe('');
  await page.reload();
  await expect(page.locator('#ra-results')).toContainText(batch);
  await rowAction(page, batch, 'Release');
  await confirmDialog(page, 'Release');
  await expect.poll(() => sql(`select status from production.batch_coa where batch_coa_id='${coa}'`), { timeout: 20_000 }).toBe('RELEASED');

  await signIn(page, 'factory', 'packaging');
  await expect(page.locator('#ra-side .who small')).toHaveText('Packaging');
  await expectRefused(page, 'POST', `/v1/batch-coas/${coa}/release`, {});
});
