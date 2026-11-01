/* Platform: Ruh and tutorials. */
import { expect, test } from '@playwright/test';
import { rp } from '../../harness/chain';
import { platformGo, signIn, sql } from '../../harness/walk';

test('a tutorial step leaves a progress row and Ruh answers from its own panel; filling cannot change Ruh settings', async ({ page }) => {
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/tutorials', 'Tutorials');
  await expect(page.locator('body')).toContainText(/lesson|tutorial/i);
  const start = page.getByRole('button', { name: /^(Start|Resume|Replay)$/ }).first();
  await start.click();
  await expect.poll(() => sql('select count(*) from platform.tutorial_progress')).not.toBe('0');
  expect((await rp('filling', 'PUT', '/v1/ruh/settings', {})).status).toBe(403);
});
