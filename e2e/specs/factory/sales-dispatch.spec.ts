/* Factory: factory sales orders and dispatch docs. */
import { expect, test } from '@playwright/test';
import { must, releasedFinishedBatch } from '../../harness/chain';
import { createDoc, createViaForm, expectRefused, openNav, signIn, sql, uniq } from '../../harness/walk';

test('a hand-entered sales order (with its reason), a dispatch, and a document on it all read back', async ({ page }, info) => {
  const c = uniq('SO', info);
  const { fg } = await releasedFinishedBatch(uniq('FGS-', info), 2);
  const customer = (await must('sales', 'POST', '/v1/customers', { customerCode: `C${c}`, customerName: `Customer ${c}` })).customerId;
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Sales orders');
  await createDoc(page, { soNumber: c, customerId: { label: `Customer ${c}` }, orderDate: '2031-05-05', reason: 'browser suite walk of the continuity path' },
    { productSkuId: { label: 'CH-SKU-1' }, orderedQty: 1, rate: 500 });
  await expect(page.locator('#ra-results')).toContainText(c);
  const so = sql(`select sales_order_id from sales.sales_order where so_number='${c}'`);
  expect(so).not.toBe('');
  expect(sql(`select origin from sales.sales_order where sales_order_id='${so}'`)).toBe('MANUAL_CONTINUITY');
  await page.locator('#ra-results tr').filter({ hasText: c }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByLabel('Why are you confirming it here?').fill('browser suite walk of the continuity path');
  await page.getByRole('button', { name: 'Confirm the order', exact: true }).click();
  await expect.poll(() => sql(`select status from sales.sales_order where sales_order_id='${so}'`)).toBe('CONFIRMED');
  await signIn(page, 'factory', 'sales');
  await openNav(page, 'Sales orders');
  await page.locator('#ra-results tr').filter({ hasText: c }).getByRole('button', { name: 'Dispatch', exact: true }).click();
  await page.locator('#ra-dfg').selectOption(fg);
  await page.locator('#ra-dq').fill('1');
  await page.locator('#ra-dv').fill('MP09AB1234');
  await page.locator('#ra-dsave').click(); // first press states what will happen
  await expect(page.locator('#ra-dsave')).toHaveAttribute('data-armed', /.+/);
  await page.locator('#ra-dsave').click();
  await expect.poll(() => sql(`select count(*) from sales.dispatch_master where sales_order_id='${so}'`), { timeout: 20_000 }).toBe('1');
  const number = `DC-${c}`;
  await openNav(page, 'Dispatch documents');
  await createViaForm(page, { dispatchId: { first: true }, documentType: 'DELIVERY_CHALLAN', documentNumber: number, documentDate: '2031-05-06' });
  await expect(page.locator('#ra-results')).toContainText(number);
  await page.reload();
  await expect(page.locator('#ra-results')).toContainText(number);
});

test('compounding is refused a sales order and a dispatch document', async ({ page }) => {
  await signIn(page, 'factory', 'compounding');
  await expect(page.locator('#ra-side .who small')).toHaveText('Compounding');
  await expectRefused(page, 'POST', '/v1/customers', { customerCode: 'NO', customerName: 'No' });
  await expectRefused(page, 'POST', '/v1/dispatch-documents', { documentType: 'INVOICE' });
});
