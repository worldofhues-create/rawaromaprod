/* Factory: pick lists and material issue. The pick list is generated on screen. The ISSUE is at the API: no
 * screen in the console posts /v1/material-issues (F8), so the floor can only read it back. */
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
  await must('compounding', 'POST', '/v1/material-issues', { productionOrderId: order, materialPickListId: pl, items: [{ materialId: mat, inventoryBatchId: invBatch, uomId: kg }] });
  const issue = sql(`select material_issue_id from production.material_issue where production_order_id='${order}'`);
  await signIn(page, 'factory', 'compounding');
  await openNav(page, 'Material issues');
  await expect(rowById(page, issue)).toBeVisible();
  await expect(page.locator('#ra-results')).not.toContainText('Chain raw material');
});

test('sales is refused a material issue', async ({ page }) => {
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/material-issues', { items: [] });
});
