/* Factory: pick lists and material issue. The pick list is generated on screen. Compounding issues it on screen,
 * naming lines and a lot: it is masked and never holds a material id. */
import { expect, test } from '@playwright/test';
import { formula, master, must, releasedStock } from '../../harness/chain';
import { expectRefused, openNav, rowById, signIn, sql } from '../../harness/walk';

test('production generates the pick list on screen; the issue reads back on Material issues, code names only', async ({ page }) => {
  const { fv } = await formula(); const { kg, mat } = await master();
  const { invBatch } = await releasedStock(4);
  const order = (await must('production', 'POST', '/v1/production-orders', { formulaVersionId: fv, orderQty: 4, uomId: kg })).order.productionOrderId;
  await must('warehouse', 'POST', '/v1/stock-reservations', { inventoryBatchId: invBatch, reservedQty: 4, uomId: kg, reservedForDocumentId: order });
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Production orders');
  await rowById(page, order).getByRole('button', { name: 'Generate pick list', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from production.material_pick_list where production_order_id='${order}'`), { timeout: 20_000 }).toBe('1');
  const pl = sql(`select material_pick_list_id from production.material_pick_list where production_order_id='${order}'`);
  await openNav(page, 'Pick lists');
  await expect(rowById(page, pl)).toBeVisible();
  await signIn(page, 'factory', 'compounding');
  await openNav(page, 'Pick lists');
  await rowById(page, pl).getByRole('button', { name: 'Issue materials', exact: true }).click();
  await expect(page.locator('#ra-issue')).not.toContainText('Chain raw material');
  await page.locator('#ra-issue select').first().selectOption(invBatch);
  await page.locator('#ra-issue-save').click();
  await expect(page.locator('#ra-issue-save')).toHaveCount(0);
  const issue = sql(`select material_issue_id from production.material_issue where production_order_id='${order}'`);
  expect(sql(`select material_id from production.material_issue_item where material_issue_id='${issue}'`)).toBe(mat);
  expect(sql(`select inventory_batch_id from production.material_issue_item where material_issue_id='${issue}'`)).toBe(invBatch);
  await openNav(page, 'Material issues');
  await expect(rowById(page, issue)).toBeVisible();
  await expect(page.locator('#ra-results')).not.toContainText('Chain raw material');
});

test('sales is refused a material issue', async ({ page }) => {
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/material-issues', { productionOrderId: '00000000-0000-4000-8000-000000000000', materialPickListId: '00000000-0000-4000-8000-000000000000', items: [{ materialPickListItemId: '00000000-0000-4000-8000-000000000000' }] });
});
