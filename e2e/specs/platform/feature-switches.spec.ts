/* Platform: feature switches. The switch is registered by SQL in this TEST database only; nothing ships in a seed
 * or migration. The empty state is checked when the database truly has none: the first run of a fresh stack, so at
 * 1440 only. The server's list is in memory and only a change adds to it, so 375 meets the registered switch. */
import { expect, test } from '@playwright/test';
import { must, rp } from '../../harness/chain';
import { platformGo, signIn, sql } from '../../harness/walk';

const KEY = 'test.e2e_fixture_switch';
test('the screen is honest with no switch, then a registered TEST switch is changed and reads back; filling is refused', async ({ page }, info) => {
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/feature-switches', 'Feature switches');
  if (sql(`select count(*) from platform.flags`) === '0') {
    await expect(page.getByRole('heading', { name: 'No switches yet' })).toBeVisible();
    sql(`insert into platform.flags (key, description) values ('${KEY}', 'E2E TEST FIXTURE')`);
    await must('platform_super_admin', 'PUT', `/v1/admin/flags/${KEY}`, { env: 'staging', state: 'on', reason: 'register the TEST switch' });
  }
  await page.reload();
  await platformGo(page, '#/feature-switches', 'Feature switches');
  const reason = `browser suite walk ${info.project.name}`;
  await page.getByRole('button', { name: `Change ${KEY}`, exact: true }).click();
  await page.getByRole('dialog').locator('select').nth(1).selectOption('off');
  await page.getByPlaceholder('Why this change?').fill(reason);
  await page.locator('[data-tutorial-target="platform-flag-save"]').click();
  await expect.poll(() => sql(`select count(*) from platform.flag_audit where reason='${reason}'`)).not.toBe('0');
  await page.reload();
  await platformGo(page, '#/feature-switches', 'Feature switches');
  await expect(page.locator('tr').filter({ hasText: KEY })).toContainText(/off/i);
  expect((await rp('filling', 'PUT', `/v1/admin/flags/${KEY}`, { env: 'staging', state: 'on', reason: 'nope' })).status).toBe(403);
});
