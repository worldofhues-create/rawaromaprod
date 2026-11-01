/* Factory: production plans. */
import { expect, test } from '@playwright/test';
import { createViaForm, expectRefused, fillForm, openNav, signIn, sql } from '../../harness/walk';

test('production raises a plan and a line, both read back; filling is refused', async ({ page }, info) => {
  const date = info.project.name.endsWith('375') ? '2031-03-11' : '2031-03-12';
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Production plans');
  const before = Number(sql('select count(*) from production.production_plan'));
  await createViaForm(page, { planDate: date });
  await expect(page.locator('#ra-results')).toContainText('2031');
  expect(Number(sql('select count(*) from production.production_plan'))).toBe(before + 1);
  await page.reload();
  await expect(page.locator('#ra-results')).toContainText('2031');

  await openNav(page, 'Plan lines');
  await page.locator('#ra-new').click();
  await fillForm(page, { productionPlanId: { first: true }, plannedQty: 25 });
  await page.locator('#ra-msave').click();
  await expect(page.locator('#ra-msave')).toHaveCount(0);
  await expect(page.locator('#ra-results')).toContainText('25');
  expect(sql(`select count(*) from production.production_plan_items where planned_qty=25`)).not.toBe('0');
});

test('filling is refused plans', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'POST', '/v1/production-plans', { planDate: '2031-01-01' });
});
