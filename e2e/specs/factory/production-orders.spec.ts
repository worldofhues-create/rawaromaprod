/* Factory: production orders, on the screen's own form. */
import { expect, test } from '@playwright/test';
import { formula, master, rp } from '../../harness/chain';
import { createViaForm, expectNoNewButton, expectRefused, factoryCall, openNav, rowById, signIn, sql } from '../../harness/walk';

test('production picks an approved formula on the form; the order reads back and its pick list is generated', async ({ page }, info) => {
  await formula(); await master();
  const qty = info.project.name.endsWith('375') ? 7.5 : 9.5;
  await signIn(page, 'factory', 'production');
  const list = await factoryCall(page, 'GET', '/v1/produce/approved-formula-versions');
  expect(list.status).toBe(200);
  // Code and version number only: the list must never carry recipe content.
  expect(Object.keys(list.json.data[0]).sort()).toEqual(['formulaId', 'formulaVersionId', 'label']);
  expect(JSON.stringify(list.json.data)).not.toContain('Chain raw material');
  await openNav(page, 'Production orders');
  const q = `select production_order_id from production.production_order where order_qty=${qty} order by created_dt desc limit 1`;
  const before = sql(q);
  await createViaForm(page, { formulaVersionId: { label: 'CH-F-1 v1' }, orderQty: qty });
  const id = sql(q);
  expect(id).not.toBe(''); expect(id).not.toBe(before);
  await expect(rowById(page, id)).toBeVisible();
  await page.reload();
  await expect(page.locator('#ra-title')).toHaveText('Production orders');
  await rowById(page, id).getByRole('button', { name: 'Generate pick list', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from production.material_pick_list where production_order_id='${id}'`), { timeout: 20_000 }).toBe('1');
});

test('compounding has no form, and sales is refused the order and the formula list', async ({ page }) => {
  const { fv } = await formula(); const { kg } = await master();
  await signIn(page, 'factory', 'compounding');
  await openNav(page, 'Production orders');
  await expectNoNewButton(page);
  await signIn(page, 'factory', 'sales');
  await expect(page.locator('#ra-side .who small')).toHaveText('Sales & Dispatch');
  await expectRefused(page, 'POST', '/v1/production-orders', { formulaVersionId: fv, orderQty: 1, uomId: kg });
  await expectRefused(page, 'GET', '/v1/produce/approved-formula-versions');
  expect((await rp('filling', 'GET', '/v1/produce/approved-formula-versions')).status).toBe(403);
});
