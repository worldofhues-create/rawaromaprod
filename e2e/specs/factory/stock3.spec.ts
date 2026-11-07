/* STOCK3: what STOCK2 left out of sight, in a browser.
 *   STOCK3-3  a TV paired to a named station shows its own alert and the general floor alert, nobody else's;
 *   STOCK3-4  the Reorder plan says which material is not totalled above the table, on screen at 375 without
 *             scrolling sideways: in the column it sat past the right edge of the phone. */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { must } from '../../harness/chain';
import { URLS } from '../../harness/config.mjs';
import { openNav, signIn, sql, uniq } from '../../harness/walk';

const unit = (code: string) => {
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', '${code}', '${code}', 'ACTIVE') on conflict do nothing`);
  return sql(`select uom_id from platform.uom_master where uom_code='${code}'`);
};

test('STOCK3-4: the Reorder plan names a material it cannot total above the table, in view', async ({ page }, info) => {
  const kg = unit('kg'), l = unit('L');
  const mat = randomUUID(), code = uniq('MS3', info);
  sql(`insert into masterdata.material (material_id, material_code, material_name, uom_id, reorder_level, status) values ('${mat}', '${code}', 'Two unit oil', '${kg}', 5, 'ACTIVE')`);
  for (const u of [kg, l]) sql(`insert into inventory.inventory_batch (inventory_batch_id, material_id, quantity_on_hand, uom_id, status) values ('${randomUUID()}', '${mat}', 1, '${u}', 'ACTIVE')`);
  await signIn(page, 'factory', 'procurement');
  await openNav(page, 'Reorder plan');
  const note = page.locator('#ra-unit-notes');
  await expect(note).toBeVisible();
  await expect(note).toContainText(code);
  await expect(note).toContainText('not totalled');
  await expect(note).toContainText('kg and L');
  const box = (await note.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await note.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('STOCK3-3: a TV paired to a station shows its own alert and the floor alert, not another station\'s', async ({ page }, info) => {
  const station = uniq('Verify', info), other = uniq('Pack', info);
  const dev = (await must('admin', 'POST', '/v1/devices', { kind: 'display', station, name: uniq('TV', info) })) as { pairing: { code: string } };
  const alert = (s: string, title: string) => sql(`insert into platform.floor_alert (floor_alert_id, kind, station, title, dedupe_key, raised_at) values ('${randomUUID()}', 'TEST', '${s}', '${title}', '${randomUUID()}', now())`);
  const own = uniq('own', info), floor = uniq('floor', info), theirs = uniq('theirs', info);
  alert(station, own); alert('Floor', floor); alert(other, theirs);
  await page.goto(`${URLS.factory}/pair.html#code=${dev.pairing.code}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.locator('#board')).toContainText(own);
  await expect(page.locator('#board')).toContainText(floor);
  await expect(page.locator('#board')).not.toContainText(theirs);
});
