/* Platform: RawProd bridge monitor, replay and discard. The counters and the replay/discard buttons need a parked
 * event. A real one takes 12 failed deliveries with backoff, so this walk parks one row by SQL (test database only);
 * the replay and discard themselves are the console's real calls. */
import { expect, test } from '@playwright/test';
import { requirement, rp, until } from '../../harness/chain';
import { platformGo, signIn, sql, uniq } from '../../harness/walk';

test('a parked update is replayed and another discarded with a reason; filling is refused', async ({ page }, info) => {
  await requirement(uniq('RAC-', info)); await requirement(uniq('RAC-', info));
  const unsent = await until('two undelivered updates', async () => {
    const ids = sql(`select o.id from bridge.outbox o join bridge.outbox_delivery d on d.outbox_id=o.id where o.published_at is null and d.parked_at is null and d.discarded_at is null order by o.seq desc limit 2`).split('\n').filter(Boolean);
    return ids.length === 2 ? ids : null;
  });
  sql(`update bridge.outbox_delivery set parked_at=now(), parked_reason='max_attempts', last_error='browser suite' where outbox_id in (${unsent.map((i) => `'${i}'`).join(',')})`);
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/alembic-bridge', 'Sales system link');
  const rows = page.locator('tr').filter({ has: page.getByRole('button', { name: 'Replay', exact: true }) });
  await expect(rows.first()).toBeVisible();
  await rows.first().getByRole('button', { name: 'Replay', exact: true }).click();
  await page.getByRole('button', { name: 'Replay update', exact: true }).click();
  await expect(page.getByText('Update queued to send again')).toBeVisible();
  await rows.first().getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'Discard update', exact: true }).click();
  await expect(page.getByText('Give a reason. It is kept in the audit log.')).toBeVisible();
  await page.locator('#held-reason').fill('browser suite walk');
  await page.getByRole('button', { name: 'Discard update', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from bridge.outbox_delivery where discard_reason='browser suite walk' and outbox_id in (${unsent.map((i) => `'${i}'`).join(',')})`)).toBe('1');
  expect((await rp('filling', 'GET', '/v1/bridge/outbox/parked')).status).toBe(403);
});
