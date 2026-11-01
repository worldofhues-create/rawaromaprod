/* Factory: pick-to-light. Simulator mode: real command rows, no shelf hardware (none exists to test). */
import { expect, test } from '@playwright/test';
import { must } from '../../harness/chain';
import { expectRefused, openNav, signIn, sql } from '../../harness/walk';

test('with the simulator on, a test light queues a command row and the shelf screens open', async ({ page }) => {
  await must('owner', 'PUT', '/v1/shelf/pick-light/config', { mode: 'simulator' });
  const before = Number(sql('select count(*) from location.pick_light_command'));
  await must('owner', 'POST', '/v1/shelf/pick-light/test', { binCode: null });
  expect(Number(sql('select count(*) from location.pick_light_command'))).toBeGreaterThan(before);
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
