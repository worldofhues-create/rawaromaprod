/* Factory: warehouse: racks, counts, transfers. */
import { expect, test } from '@playwright/test';
import { master, releasedStock } from '../../harness/chain';
import { createViaForm, expectRefused, expectRowPersisted, openNav, signIn, sql, uniq } from '../../harness/walk';

test('warehouse counts, adjusts and transfers real stock; each reads back and the ledger moves', async ({ page }, info) => {
  const c = uniq('W', info);
  await master();
  const { invBatch } = await releasedStock(8);
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Stock on hand');
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
  await openNav(page, 'Stock counts');
  await createViaForm(page, { auditCode: `CNT${c}`, auditType: 'SPOT' });
  await expectRowPersisted(page, `CNT${c}`, () => sql(`select count(*) from inventory.stock_audit where audit_code='CNT${c}'`), 'Stock counts');
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
  await expectRefused(page, 'POST', '/v1/stock-audits', { auditCode: 'NO' });
  await expectRefused(page, 'GET', '/v1/stock-audits');
});
