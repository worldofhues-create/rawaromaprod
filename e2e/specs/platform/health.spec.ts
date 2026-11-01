/* Platform: hand-over and health. */
import { expect, test } from '@playwright/test';
import { EMAIL, signIn, sql } from '../../harness/walk';

test('platform admin lands on Health with real parts answering, leaving a sign-in row; filling is refused at the door', async ({ page }) => {
  const q = `select count(*) from iam.login_history where email='${EMAIL.platform_super_admin}' and console='platform'`;
  const before = Number(sql(q));
  await signIn(page, 'platform', 'platform_super_admin');
  await expect(page.locator('h1').first()).toHaveText('Health');
  await expect(page.getByText('Messages waiting to be sent')).toBeVisible();
  expect(Number(sql(q))).toBeGreaterThan(before);
  await page.goto('about:blank');
  await signIn(page, 'platform', 'filling');
  await expect(page.getByRole('heading', { name: 'Health', exact: true })).toHaveCount(0);
  await expect(page.locator('[role="alert"]').first()).not.toBeEmpty();
});
