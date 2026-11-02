/* Factory: pick-to-light. Simulator mode: real command rows, no shelf hardware (none exists to test). */
import { expect, test } from '@playwright/test';
import { expectRefused, openNav, platformGo, signIn, sql } from '../../harness/walk';

test('with the simulator on, a test light pressed on Platform queues a command row and the Factory shelf screens open', async ({ page }) => {
  // Factory has no test button; Platform's Pick-to-light screen is where a person presses it.
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/pick-to-light', 'Pick-to-light');
  await page.locator('select.fld').first().selectOption('simulator');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect.poll(() => sql('select mode from location.pick_light_config limit 1')).toBe('simulator');
  await page.reload();
  const before = Number(sql('select count(*) from location.pick_light_command'));
  await page.getByRole('button', { name: /test light/i }).click();
  await expect.poll(() => Number(sql('select count(*) from location.pick_light_command'))).toBeGreaterThan(before);
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Put-away & pick');
  await expect(page.locator('#ra-view')).not.toContainText('not available');
  await openNav(page, 'Shelf display');
  await expect(page.locator('#ra-view')).not.toContainText('not available');
});

test('filling cannot change the configuration', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'PUT', '/v1/shelf/pick-light/config', { mode: 'simulator' });
});
