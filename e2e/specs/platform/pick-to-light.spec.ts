/* Platform: pick-to-light settings. Simulator: no hardware exists to test. */
import { expect, test } from '@playwright/test';
import { rp } from '../../harness/chain';
import { platformGo, signIn, sql } from '../../harness/walk';

test('the mode is saved, reads back, and a test light queues a command; filling is refused', async ({ page }) => {
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/pick-to-light', 'Pick-to-light');
  const mode = page.locator('select.fld').first();
  await expect(mode).toBeVisible();
  await mode.selectOption('simulator');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect.poll(() => sql('select mode from location.pick_light_config limit 1')).toBe('simulator');
  await page.reload();
  await expect(page.locator('select.fld').first()).toHaveValue('simulator');
  const before = Number(sql('select count(*) from location.pick_light_command'));
  await page.getByRole('button', { name: /test light/i }).click();
  await expect.poll(() => Number(sql('select count(*) from location.pick_light_command'))).toBeGreaterThan(before);
  expect((await rp('filling', 'PUT', '/v1/shelf/pick-light/config', { mode: 'off' })).status).toBe(403);
});
