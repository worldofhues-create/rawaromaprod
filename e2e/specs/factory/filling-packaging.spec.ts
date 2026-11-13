/* Factory: filling and packaging. */
import { expect, test } from '@playwright/test';
import { master, releasedOil, sku } from '../../harness/chain';
import { createViaForm, expectRefused, openNav, rowById, confirmDialog, signIn, sql, uniq } from '../../harness/walk';
import { must } from '../../harness/chain';

test('packaging raises an order against released oil and filling ends a ticket; both read back', async ({ page }, info) => {
  await master(); await sku();
  const { oil, batchNumber: batch } = await releasedOil(2); // the number the server assigned (PROM-4)
  await signIn(page, 'factory', 'packaging');
  await openNav(page, 'Packing orders');
  await createViaForm(page, { productSkuId: { label: 'CH-SKU-1' }, oilBatchId: { label: batch }, orderQty: 2 });
  const pkg = sql(`select package_order_id from packaging.package_order where oil_batch_id='${oil}'`);
  expect(pkg).not.toBe('');
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
  await must('packaging', 'POST', `/v1/package-orders/${pkg}/issue-materials`, {});

  await signIn(page, 'factory', 'filling');
  await openNav(page, 'Fill tickets');
  await createViaForm(page, { packageOrderId: pkg });
  const fill = sql(`select filling_session_id from packaging.filling_session where package_order_id='${pkg}'`);
  expect(fill).not.toBe('');
  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Fill tickets');
  await rowById(page, fill).getByRole('button', { name: 'Record fill', exact: true }).click();
  await page.getByLabel('Filled quantity').fill('1'); // units are real: a pack is counted whole, and the SKU holds 1 kg a pack (1.75 packs is refused)
  await page.getByRole('button', { name: 'Save fill', exact: true }).click();
  await expect.poll(() => sql(`select filled_qty::numeric from packaging.filling_session_details where filling_session_id='${fill}'`)).toMatch(/^1(\.0+)?$/);
  await rowById(page, fill).getByRole('button', { name: 'End fill', exact: true }).click();
  await confirmDialog(page, 'End fill');
  await expect.poll(() => sql(`select status from packaging.filling_session where filling_session_id='${fill}'`), { timeout: 20_000 }).toBe('DONE');
});

test('sales is refused a package order', async ({ page }) => {
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/package-orders', { orderQty: 1 });
});
