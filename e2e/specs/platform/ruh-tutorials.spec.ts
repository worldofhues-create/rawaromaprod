/* Platform: Ruh and tutorials. */
import { expect, test } from '@playwright/test';
import { requirement, must, rp } from '../../harness/chain';
import { platformGo, signIn, sql, uniq } from '../../harness/walk';

test('a tutorial step leaves a progress row; filling cannot change Ruh settings', async ({ page }) => {
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/tutorials', 'Tutorials');
  await page.getByRole('button', { name: /^(Start|Resume|Replay)$/ }).first().click();
  await expect.poll(() => sql('select count(*) from platform.tutorial_progress')).not.toBe('0');
  expect((await rp('filling', 'PUT', '/v1/ruh/settings', {})).status).toBe(403);
});

test('Ruh watches, its note shows in the panel, and marking it done is saved; filling cannot run the watch', async ({ page }, info) => {
  await requirement(uniq('RAC-', info));
  await must('platform_super_admin', 'POST', '/v1/ruh/watch/run', {});
  const open = sql(`select count(*) from platform.ruh_insight where status='open'`);
  expect(Number(open), 'the watch found something to say').toBeGreaterThan(0);
  await signIn(page, 'factory', 'owner');
  await page.locator('[data-ruh-badge]').first().click();
  const card = page.locator('#ra-ruh-panel [data-ruh-insight]').first();
  await expect(card).toBeVisible();
  const id = await card.getAttribute('data-ruh-insight');
  await card.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => sql(`select status from platform.ruh_insight where ruh_insight_id='${id}'`)).not.toBe('open');
  const next = async (act: (c: import('@playwright/test').Locator) => Promise<void>, want: RegExp) => {
    await must('platform_super_admin', 'POST', '/v1/ruh/watch/run', {});
    await page.reload();
    await page.locator('[data-ruh-badge]').first().click();
    const c = page.locator('#ra-ruh-panel [data-ruh-insight]').first();
    await expect(c).toBeVisible();
    const cid = await c.getAttribute('data-ruh-insight');
    await act(c);
    await expect.poll(() => sql(`select status from platform.ruh_insight where ruh_insight_id='${cid}'`)).toMatch(want);
  };
  await next(async (c) => { await c.getByRole('button', { name: 'Snooze', exact: true }).click(); await c.getByRole('button', { name: '1 hour', exact: true }).click(); }, /snooz/i);
  await next(async (c) => { await c.getByRole('button', { name: 'Dismiss', exact: true }).click(); }, /dismiss/i);
  expect((await rp('filling', 'POST', '/v1/ruh/watch/run', {})).status).toBe(403);
});
