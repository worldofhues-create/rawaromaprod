/* Factory: defects found documenting the console. Rail against route and role, the floor map, human
 * numbers, formatted times, the printed heading, and the focus pill on a phone. */
import { expect, test } from '@playwright/test';
import { issuedPo, must, orderWithIssuedStock, releasedFinishedBatch } from '../../harness/chain';
import { createViaForm, factoryCall, openNav, signIn, sql, uniq } from '../../harness/walk';

const railLabels = (page: import('@playwright/test').Page) => page.locator('#ra-railnav button.ri').allInnerTexts();

test('owner rail: no Formula history, no Notifications, and the server still refuses the owner notifications', async ({ page }) => {
  await signIn(page, 'factory', 'owner');
  await expect(page.locator('#ra-side .who small')).toHaveText('Owner');
  const labels = (await railLabels(page)).join('|');
  expect(labels).not.toMatch(/Formula history|Notifications sent/);
  expect((await factoryCall(page, 'GET', '/v1/notifications')).status).toBe(403);
});

for (const screen of ['Location types', 'Locations', 'Contacts', 'Countries']) {
  test(`admin opens ${screen} and may not add one`, async ({ page }) => {
    await signIn(page, 'factory', 'admin');
    await openNav(page, screen);
    await expect(page.getByText('Not part of your role')).toHaveCount(0);
    await expect(page.locator('#ra-new')).toHaveCount(0);
  });
}

test('admin adds a document; it reads back', async ({ page }, info) => {
  const title = uniq('DOC', info);
  await signIn(page, 'factory', 'admin');
  await openNav(page, 'Documents');
  await createViaForm(page, { title, documentType: 'Other' });
  await expect(page.locator('#ra-results')).toContainText(title);
  expect(sql(`select count(*) from platform.document_registry where title='${title}'`)).toBe('1');
});

test('floor map shows only zones in the database, or says there are none', async ({ page }, info) => {
  const code = uniq('ZN', info);
  await signIn(page, 'factory', 'warehouse');
  await expect(page.locator('#ra-side .who small')).toHaveText('Warehouse');
  await expect(page.getByText(/Citrus|Florals|Flammables/)).toHaveCount(0);
  if (sql('select count(*) from location.zone_master') === '0') await expect(page.locator('#ra-zones-empty')).toBeVisible();
  await openNav(page, 'Zones');
  await createViaForm(page, { zoneCode: code, zoneName: `Walk ${code}` });
  const dash = await factoryCall(page, 'GET', '/v1/dashboard');
  const zones = dash.json.data.zones as Array<{ code: string; capPct: number | null }>;
  expect(zones.map((z) => z.code).sort()).toEqual(sql('select zone_code from location.zone_master').split('\n').sort());
  expect(zones.find((z) => z.code === code)!.capPct).toBeNull();
});

test('a production order shows its number on its list and on the issue', async ({ page }) => {
  const { order } = await orderWithIssuedStock();
  const number = sql(`select order_number from production.production_order where production_order_id='${order}'`);
  expect(number).toMatch(/^MO-[0-9A-F]{12}$/);
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Production orders');
  await expect(page.locator('#ra-results')).toContainText(number);
  await expect(page.locator('#ra-results')).not.toContainText(order.slice(0, 8).toUpperCase());
  await openNav(page, 'Pick lists');
  await expect(page.locator('#ra-results')).toContainText(number);
  await openNav(page, 'Material issues');
  await expect(page.locator('#ra-results')).toContainText(number);
});

test('finished stock shows its batch number and readable times', async ({ page }) => {
  const { fg, fgNumber: number } = await releasedFinishedBatch(); // the lot the server assigned at fill (PROM-4)
  await must('packaging', 'POST', '/v1/fg-reservations', { finishedGoodBatchId: fg, reservedQty: 1 });
  await signIn(page, 'factory', 'packaging');
  await openNav(page, 'Reserved finished stock');
  await expect(page.locator('#ra-results')).toContainText(number);
  await expect(page.locator('#ra-results')).not.toContainText(fg.slice(0, 8).toUpperCase());
  const raw = /\d{4}-\d{2}-\d{2}[T ]\d{2}:/;
  for (const screen of ['Product labels', 'Packaging QC']) {
    await openNav(page, screen);
    await expect(page.locator('#ra-results tbody tr').first()).toBeVisible();
    await expect(page.locator('#ra-results')).not.toContainText(raw);
    await expect(page.locator('#ra-results')).toContainText(/\d{2} [A-Z][a-z]{2} \d{4}/);
  }
});

test('a printed purchase order has the new heading and no record id', async ({ page, context }) => {
  const { po, number } = await issuedPo(2);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Purchase orders');
  await page.locator('#ra-search').fill(number);
  const [w] = await Promise.all([context.waitForEvent('page'), page.locator('#ra-results tbody tr').filter({ hasText: number }).first().getByRole('button', { name: 'Print', exact: true }).click()]);
  await expect(w.locator('h1')).toHaveText('Raw Aromachem');
  await expect(w.locator('body')).toContainText(number);
  await expect(w.locator('body')).not.toContainText(po.slice(0, 8));
  await expect(w.locator('body')).not.toContainText(po.slice(0, 8).toUpperCase());
});

test('the Exit focus mode pill does not cover the title', async ({ page }) => {
  await signIn(page, 'factory', 'owner');
  await expect(page.locator('#ra-title')).toBeVisible();
  const overlap = await page.evaluate(async () => {
    const b = document.querySelector('.ra-focus-exit') as HTMLElement | null ?? (() => { const x = document.createElement('button'); x.className = 'ra-focus-exit'; x.textContent = 'Exit focus mode'; document.body.appendChild(x); return x; })();
    b.hidden = false; b.classList.add('show');
    await new Promise((r) => setTimeout(r, 300));
    const p = b.getBoundingClientRect(), t = document.getElementById('ra-title')!.getBoundingClientRect();
    return !(p.right <= t.left || p.left >= t.right || p.bottom <= t.top || p.top >= t.bottom);
  });
  expect(overlap).toBe(false);
  // A sheet's title is at the top of the screen, whichever sheet is open: on a phone the pill stays below the middle.
  const top = await page.locator('.ra-focus-exit').evaluate((b) => b.getBoundingClientRect().top);
  if ((page.viewportSize()?.width ?? 0) < 720) expect(top).toBeGreaterThan(400);
});
