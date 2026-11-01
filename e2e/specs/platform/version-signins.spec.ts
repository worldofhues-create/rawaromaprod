/* Platform: version and sign-in history. */
import { expect, test } from '@playwright/test';
import { rp } from '../../harness/chain';
import { platformGo, EMAIL, signIn } from '../../harness/walk';

test('the sign-in history lists this very sign-in, and the version screen answers; filling is refused', async ({ page }) => {
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/sign-in-history', 'Sign-in history');
  await expect(page.locator('tbody')).toContainText(EMAIL.platform_super_admin!);
  await page.evaluate(() => { location.hash = '#/version'; });
  await expect(page.locator('body')).not.toContainText('not available');
  expect((await rp('filling', 'GET', '/v1/login-history')).status).toBe(403);
});
