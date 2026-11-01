/* Platform: feature switches. */
import { expect, test } from '@playwright/test';
import { rp } from '../../harness/chain';
import { platformGo, signIn, sql } from '../../harness/walk';

test('a switch is changed with a reason and the state reads back; filling is refused', async ({ page }, info) => {
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/feature-switches', 'Feature switches');
  const row = page.locator('tbody tr').first();
  await expect(row).toBeVisible();
  await row.getByRole('button').first().click();
  await page.getByPlaceholder('Why this change?').fill(`browser suite walk ${info.project.name}`);
  await page.locator('[data-tutorial-target="platform-flag-save"]').click();
  await expect.poll(() => sql('select count(*) from platform.flag_states')).not.toBe('0');
  expect((await rp('filling', 'PUT', '/v1/admin/flags/anything', { env: 'staging', state: 'on', reason: 'nope' })).status).toBe(403);
});
