/* Factory: filling and packaging. */
import { expect, test } from '@playwright/test';
import { master, releasedOil, sku } from '../../harness/chain';
import { createViaForm, expectRefused, openNav, rowById, confirmDialog, signIn, sql, uniq } from '../../harness/walk';
import { must } from '../../harness/chain';

test('packaging raises an order against released oil and filling ends a ticket; both read back', async ({ page }, info) => {
  const batch = uniq('OBP-', info);
  await master(); await sku();
  const { oil } = await releasedOil(batch, 2);
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
  await must('filling', 'POST', `/v1/filling-sessions/${fill}/details`, { filledQty: 2, rejectedQty: 0, uomId: (await master()).kg });
  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Fill tickets');
  await rowById(page, fill).getByRole('button', { name: 'End fill', exact: true }).click();
  await confirmDialog(page, 'End fill');
  await expect.poll(() => sql(`select status from packaging.filling_session where filling_session_id='${fill}'`), { timeout: 20_000 }).toBe('DONE');
});

test('sales is refused a package order', async ({ page }) => {
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/package-orders', { orderQty: 1 });
});
