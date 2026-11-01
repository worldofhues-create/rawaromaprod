/* Factory: production orders. Walked through what the floor can actually press: Produce next -> Plan run.
 * The Production orders screen's own "+ New" form is NOT walked: see finding F2 in e2e/FINDINGS.md. */
import { expect, test } from '@playwright/test';
import { formula, master, must } from '../../harness/chain';
import { expectRefused, openNav, rowById, signIn, sql } from '../../harness/walk';

test('an order raised from an approved formula reads back; its pick list is generated from the row', async ({ page }, info) => {
  await formula(); const { kg } = await master(); const { fv } = await formula();
  const qty = info.project.name.endsWith('375') ? 7 : 9;
  const created = await must('production', 'POST', '/v1/production-orders', { formulaVersionId: fv, orderQty: qty, uomId: kg });
  const number = created.order.productionOrderId as string;
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Production orders');
  await rowById(page, number).getByRole('button', { name: 'Generate pick list', exact: true }).click();
  const id = number;
  await expect.poll(() => sql(`select count(*) from production.material_pick_list where production_order_id='${id}'`), { timeout: 20_000 }).toBe('1');
  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Production orders');
  await expect(rowById(page, number)).toBeVisible();
});

test('sales is refused a production order', async ({ page }) => {
  const { fv } = await formula(); const { kg } = await master();
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/production-orders', { formulaVersionId: fv, orderQty: 1, uomId: kg });
});
