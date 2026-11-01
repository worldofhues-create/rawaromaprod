/* Platform: bridge monitor, replay and discard. A real parking path: a peer answering 422 is a permanent failure, so
 * the real relay parks the event on its first delivery. The peer then answers 200 and the replay really delivers. */
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { PORTS } from '../../harness/config.mjs';
import { requirement, rp, until } from '../../harness/chain';
import { platformGo, signIn, sql, uniq } from '../../harness/walk';

test('updates refused by the peer park; one is replayed and delivered, one discarded with a reason; filling is refused', async ({ page }, info) => {
  let answer = 422;
  const peer = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(answer, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise<void>((r) => peer.listen(PORTS.deadPeer, '127.0.0.1', () => r()));
  try {
    const a = await requirement(uniq('RAC-', info)); const b = await requirement(uniq('RAC-', info));
    const parkedFor = (agg: string) => until(`the update for ${agg} to park`, async () => sql(`select o.id from bridge.outbox o join bridge.outbox_delivery d on d.outbox_id=o.id where o.aggregate_id='${agg}' and d.parked_reason='permanent' and d.discarded_at is null limit 1`) || null, 60_000);
    const first = await parkedFor(a.requirementId); const second = await parkedFor(b.requirementId);
    answer = 200;
    await signIn(page, 'platform', 'platform_super_admin');
    await platformGo(page, '#/alembic-bridge', 'Sales system link');
    const rowOf = (id: string) => page.locator('tr').filter({ has: page.getByRole('button', { name: 'Replay', exact: true }) }).nth(id === first ? 0 : 0);
    const order = sql(`select o.id from bridge.outbox o join bridge.outbox_delivery d on d.outbox_id=o.id where d.parked_at is not null and d.discarded_at is null and o.published_at is null order by d.parked_at, o.seq limit 1`);
    await rowOf(first).getByRole('button', { name: 'Replay', exact: true }).click();
    await page.getByRole('button', { name: 'Replay update', exact: true }).click();
    await expect(page.getByText('Update queued to send again')).toBeVisible();
    await expect.poll(() => sql(`select count(*) from bridge.outbox where id='${order}' and published_at is not null`), { timeout: 30_000 }).toBe('1');
    await rowOf(second).getByRole('button', { name: 'Discard', exact: true }).click();
    await page.getByRole('button', { name: 'Discard update', exact: true }).click();
    await expect(page.getByText('Give a reason. It is kept in the audit log.')).toBeVisible();
    const why = `browser suite ${info.project.name}`;
    await page.locator('#held-reason').fill(why);
    await page.getByRole('button', { name: 'Discard update', exact: true }).click();
    await expect.poll(() => sql(`select count(*) from bridge.outbox_delivery where discard_reason='${why}'`)).toBe('1');
    expect((await rp('filling', 'GET', '/v1/bridge/outbox/parked')).status).toBe(403);
  } finally { await new Promise((r) => peer.close(r)); }
});
