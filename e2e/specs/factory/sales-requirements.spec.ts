/* Factory: sales requirements and produce next. ALEMBIC is stood in for by a correctly signed event on
 * the real inbound route; everything after that is RawProd's own. */
import { expect, test } from '@playwright/test';
import { requirement, signedEvent } from '../../harness/chain';
import { confirmDialog, expectRefused, openNav, signIn, sql, uniq } from '../../harness/walk';

test('a signed requirement reaches the queue and Plan run creates a production order linked to it', async ({ page }, info) => {
  const orderRef = uniq('RAC-', info);
  const { requirementId } = await requirement(orderRef);
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Sales requirements');
  await expect(page.locator('#ra-results')).toContainText(orderRef);
  expect(sql(`select count(*) from bridge.production_requirement where alembic_requirement_id='${requirementId}'`)).toBe('1');
  await openNav(page, 'Produce next');
  const row = page.locator('#ra-view tr').filter({ hasText: orderRef }).locator('[data-plan]');
  await expect(row).toBeVisible();
  await row.click();
  await confirmDialog(page, 'Plan run');
  // Other walks' orders rank ahead of this one: Ruh warns and a typed reason lets the planner go on.
  const why = page.getByPlaceholder('Why are you going ahead? (at least 8 characters)');
  await why.waitFor({ timeout: 5_000 }).then(async () => {
    await why.fill('browser suite walk, planned out of turn');
    await page.getByRole('button', { name: 'Go ahead', exact: true }).click();
  }).catch(() => { /* this order was first in the queue: no warning to answer */ });
  await expect.poll(() => sql(`select coalesce(production_order_id::text,'') from bridge.production_requirement where alembic_requirement_id='${requirementId}'`), { timeout: 30_000 }).not.toBe('');
});

test('an unsigned or tampered event is refused and the queue is untouched', async ({ page }, info) => {
  const orderRef = uniq('BAD-', info);
  await requirement(uniq('OK-', info));
  const res = await fetch(`http://127.0.0.1:${process.env.BS_API_PORT || 4310}/v1/bridge/alembic/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-signature': 'sha256=00' }, body: JSON.stringify({ order_ref: orderRef }) });
  expect(res.status).toBe(401);
  expect((await signedEvent('NotAnEventAnybodySends', crypto.randomUUID(), {})).status).toBe(400);
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Sales requirements');
  await expect(page.locator('#ra-results')).not.toContainText(orderRef);
});

test('filling is refused the queue and the plan action', async ({ page }) => {
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'POST', '/v1/produce/requirements/00000000-0000-0000-0000-000000000000/plan', {});
});
