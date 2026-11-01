/* Factory: pick lists and material issue. */
import { expect, test } from '@playwright/test';
import { orderWithIssuedStock } from '../../harness/chain';
import { expectRefused, openNav, signIn, sql } from '../../harness/walk';

test('picked and issued stock reads back on the Pick lists and Material issues screens; the coded names only', async ({ page }) => {
  const { order } = await orderWithIssuedStock(4);
  const pl = sql(`select material_pick_list_id from production.material_pick_list where production_order_id='${order}'`);
  expect(pl).not.toBe('');
  expect(sql(`select count(*) from production.material_issue where production_order_id='${order}'`)).toBe('1');
  await signIn(page, 'factory', 'compounding');
  await openNav(page, 'Pick lists');
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
  await openNav(page, 'Material issues');
  await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
  await expect(page.locator('#ra-results')).not.toContainText('Chain raw material');
});

test('sales is refused a material issue', async ({ page }) => {
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/material-issues', { items: [] });
});
