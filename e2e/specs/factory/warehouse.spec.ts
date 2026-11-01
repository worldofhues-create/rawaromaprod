/* Factory: warehouse: racks, counts, transfers. */
import { expect, test } from '@playwright/test';
import { master, must, releasedStock } from '../../harness/chain';
import { expectRefused, openNav, signIn, sql, uniq } from '../../harness/walk';

test('warehouse counts, adjusts and transfers real stock; each reads back and the ledger moves', async ({ page }, info) => {
  const c = uniq('W', info);
  await master();
  const { invBatch } = await releasedStock(8);
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Stock on hand');
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
  // F4: NOT walked on screen. Warehouse's rail has Stock counts but the role holds neither its read nor
  // its write; Owner holds both and has no such screen. The count is raised and checked at the API only.
  await must('owner', 'POST', '/v1/stock-audits', { auditCode: `CNT${c}`, auditType: 'SPOT' });
  expect(sql(`select count(*) from inventory.stock_audit where audit_code='CNT${c}'`)).toBe('1');
  await openNav(page, 'Stock adjustments');
  const adj = Number(sql(`select count(*) from inventory.stock_adjustment where inventory_batch_id='${invBatch}'`));
  await page.locator('#ra-new').click();
  await page.locator('[data-name="inventoryBatchId"]').selectOption(invBatch);
  await page.locator('[data-name="adjustmentQty"]').fill('-0.5');
  await page.locator('[data-name="adjustmentReason"]').fill(`walk ${c}`);
  await page.locator('#ra-msave').click();
  await expect(page.locator('#ra-msave')).toHaveCount(0);
  expect(Number(sql(`select count(*) from inventory.stock_adjustment where inventory_batch_id='${invBatch}'`))).toBe(adj + 1);
  await page.reload();
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
  await openNav(page, 'Stock transfers');
  await page.locator('#ra-new').click();
  await page.locator('[data-name="inventoryBatchId"]').selectOption(invBatch);
  await page.locator('[data-name="transferQty"]').fill('1');
  await page.locator('#ra-msave').click();
  await expect(page.locator('#ra-msave')).toHaveCount(0);
  expect(sql(`select count(*) from inventory.stock_transfer where inventory_batch_id='${invBatch}'`)).not.toBe('0');
});

test('sales is refused a stock movement', async ({ page }) => {
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/stock-adjustments', { adjustmentQty: 1 });
  await expectRefused(page, 'POST', '/v1/stock-transfers', { transferQty: 1 });
});
