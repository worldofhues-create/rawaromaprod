/* STOCK2: what the floor sees of the stock ledger, in a browser.
 *   STOCK2-1  a reading over the pick is held on the Verify screen; a supervisor records why on the queue;
 *   STOCK2-4  a refused debit is an alert with a next action on the floor's screens and the supervisor's;
 *   STOCK2-5  at 375 Scan a lot's cards keep their padding, and "Exit focus mode" never sits on a card. */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { must } from '../../harness/chain';
import { openNav, signIn, sql, uniq } from '../../harness/walk';
import { wedge } from '../../harness/labels';

const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const EXPIRY = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
const KIOSK = { station: 'Verify 1', screen: 'floorverify', deviceId: 'walk' };

async function job(info: TestInfo) {
  const fam = uniq('fs2', info).toLowerCase();
  await must('admin', 'PUT', `/v1/floor/families/${fam}`, { familyName: 'Stock family', colourName: 'Tone' + letters(), colourHex: '#8B5A2B' });
  const mat = randomUUID();
  sql(`insert into masterdata.material (material_id, material_code, material_name, status) values ('${mat}', '${uniq('MS2', info)}', 'Stock oil', 'ACTIVE')`);
  await must('procurement', 'POST', '/v1/floor/codes', { materialId: mat, familyCode: fam });
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'g', 'gram', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const home = (uniq('B2', info) + letters()).toUpperCase();
  sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${randomUUID()}', '${home}', 'ACTIVE')`);
  const rb = randomUUID(), ib = randomUUID();
  sql(`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values ('${rb}', '${mat}', '${uniq('RM2', info)}${letters()}', '${EXPIRY}', 'ACTIVE')`);
  sql(`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values ('${randomUUID()}', '${rb}', 'ACCEPT')`);
  sql(`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status)
       select '${ib}', '${rb}', '${mat}', bin_id, 1000, '${g}', 'ACTIVE' from location.bin_master where bin_code = '${home}'`);
  const lotCode = ((await must('warehouse', 'POST', `/v1/floor/lots/${ib}/barcode`)) as { barcode: string }).barcode;
  const order = randomUUID(), pl = randomUUID();
  sql(`insert into production.production_order (production_order_id, order_qty, uom_id, status) values ('${order}', 1, '${g}', 'INPROGRESS')`);
  sql(`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values ('${pl}', '${order}', 'ACTIVE')`);
  sql(`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values ('${randomUUID()}', '${order}', '${mat}', 125.5, false, '${g}', 'ACTIVE')`);
  sql(`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values ('${randomUUID()}', '${pl}', '${mat}', 125.5, '${g}', 'ACTIVE')`);
  const j = (await must('production', 'POST', '/v1/floor/jobs', { productionOrderId: order, steps: [] })) as { floorJobId: string; jobNo: string };
  return { ...j, ib, pl, lotCode };
}
async function pick(j: { floorJobId: string }) {
  const pv = (await must('picker', 'GET', `/v1/floor/jobs/${j.floorJobId}/pick`)) as { lines: Array<{ floorLineId: string; takeLot: { barcode: string; bin: string } }> };
  await must('picker', 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/lines/${pv.lines[0]!.floorLineId}`, { bin: pv.lines[0]!.takeLot.bin, barcode: pv.lines[0]!.takeLot.barcode });
  const tote = ('T-' + letters()).toUpperCase();
  await must('picker', 'POST', `/v1/floor/jobs/${j.floorJobId}/pick/complete`, { tote });
  return tote;
}
const onHand = (ib: string) => sql(`select quantity_on_hand from inventory.inventory_batch where inventory_batch_id = '${ib}'`);
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('STOCK2-1: under the pick the leftover stays on the lot; over it the reading is held until a supervisor records why', async ({ page }, info) => {
  test.setTimeout(180_000);
  // under
  const a = await job(info);
  const toteA = await pick(a);
  await expect.poll(() => onHand(a.ib), { timeout: 20_000 }).toBe('874.5000');
  await signIn(page, 'factory', 'verifier');
  await openNav(page, 'Verify');
  await page.locator('#fl-tote').fill(toteA);
  await page.locator('#fl-go').click();
  await expect(page.locator('#fl-wt')).toBeVisible();
  await page.locator('#fl-wt').fill('125.2');
  await page.locator('#fl-wtick').click();
  await expect(page.locator('#ra-view')).toContainText('125.2 g typed');
  await expect.poll(() => onHand(a.ib)).toBe('874.8000');
  // over
  const b = await job(info);
  const toteB = await pick(b);
  await expect.poll(() => onHand(b.ib), { timeout: 20_000 }).toBe('874.5000');
  await openNav(page, 'Floor queue');
  await openNav(page, 'Verify');
  await page.locator('#fl-tote').fill(toteB);
  await page.locator('#fl-go').click();
  await page.locator('#fl-wt').fill('125.7');
  await page.locator('#fl-wtick').click();
  await expect(page.locator('#ra-view')).toContainText('held for a supervisor');
  await expect(page.locator('#fl-stock-alerts')).toContainText(`${b.jobNo} line 1 weighed over the pick`);
  await expect(page.locator('#fl-stock-alerts')).toContainText('Next:');
  await expect(page.locator('[data-over]')).toHaveCount(0); // the verifier cannot answer it
  expect(onHand(b.ib)).toBe('874.5000');
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('verify-held.png'), fullPage: true });
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Floor queue');
  const box = page.locator('#fl-stock-alerts');
  await expect(box).toContainText(b.jobNo);
  await box.locator('[data-over]').first().click();
  await page.locator('[data-ask="reason"]').fill('Drum neck dripped into the tote');
  await page.getByRole('button', { name: 'Record and accept the reading', exact: true }).click();
  await expect.poll(() => onHand(b.ib)).toBe('874.3000');
  await expect.poll(() => sql(`select over_reason from production.floor_line where floor_job_id = '${b.floorJobId}'`)).toBe('Drum neck dripped into the tote');
  await expect(page.locator('#fl-stock-alerts')).toHaveCount(0);
});

test('STOCK2-4: a refused debit reaches the Verify kiosk and the Floor queue with the next action, and closes when it runs', async ({ page }, info) => {
  test.setTimeout(180_000);
  const j = await job(info);
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'litre', 'litre', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`), l = sql(`select uom_id from platform.uom_master where uom_code='litre'`);
  await pick({ floorJobId: j.floorJobId }).catch(() => {}); // the poller may win this race on a slow box; the unit below is what makes it refuse
  const issue = sql(`select material_issue_id from production.material_issue mi join production.floor_job fj using (production_order_id) where fj.floor_job_id = '${j.floorJobId}'`);
  // Refused as the consumer sees an issue already raised: the applied row goes, the unit is wrong, the debit retries.
  sql(`update inventory.inventory_batch set quantity_on_hand = 1000 where inventory_batch_id = '${j.ib}'`);
  sql(`delete from inventory.inventory_event_history where reference_document_id = '${issue}'`);
  sql(`update production.material_pick_list_items set uom_id = '${l}' where material_pick_list_id = '${j.pl}'`);
  sql(`delete from inventory.material_issue_applied where material_issue_id = '${issue}'`);
  await expect.poll(() => sql(`select count(*) from platform.floor_alert where kind = 'STOCK_DEBIT_REFUSED' and subject_id = '${issue}' and cleared_at is null`), { timeout: 20_000 }).toBe('1');
  await page.addInitScript((k) => { try { localStorage.setItem('ra.kiosk', JSON.stringify(k)); } catch (e) { /* about:blank */ } }, KIOSK);
  await signIn(page, 'factory', 'verifier');
  await expect(page.locator('html')).toHaveClass(/ra-kiosk/);
  const box = page.locator('#fl-stock-alerts');
  await expect(box).toContainText(`${j.jobNo} has not been taken off stock`);
  await expect(box).toContainText('Next:');
  await expect(box).toContainText('density');
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('kiosk-refused.png'), fullPage: true });
  sql(`update production.material_pick_list_items set uom_id = '${g}' where material_pick_list_id = '${j.pl}'`);
  await expect.poll(() => onHand(j.ib), { timeout: 20_000 }).toBe('874.5000');
  await expect.poll(() => sql(`select count(*) from platform.floor_alert where kind = 'STOCK_DEBIT_REFUSED' and subject_id = '${issue}' and cleared_at is null`), { timeout: 20_000 }).toBe('0');
});

test('STOCK2-5: Scan a lot keeps its padding at 375, and Exit focus mode leaves the cards alone', async ({ page }, info) => {
  test.setTimeout(120_000);
  const j = await job(info);
  await pick(j);
  await signIn(page, 'factory', 'verifier');
  await openNav(page, 'Scan a lot');
  await wedge(page, '#fl-sci', j.lotCode, ']Q1', 'Enter');
  await expect(page.locator('#fl-left .card')).toBeVisible();
  const pads = await page.locator('#ra-view .card').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).paddingLeft)));
  console.log('card padding-left', JSON.stringify(pads));
  expect(Math.min(...pads)).toBeGreaterThanOrEqual(14);
  await page.evaluate(() => document.documentElement.requestFullscreen());
  const pill = page.locator('.ra-focus-exit');
  await expect(pill).toBeVisible();
  await page.locator('#fl-left .card').scrollIntoViewIfNeeded();
  const hit = await page.evaluate(() => {
    const p = document.querySelector('.ra-focus-exit')!.getBoundingClientRect();
    return [...document.querySelectorAll('#ra-view .card')].some((c) => { const r = c.getBoundingClientRect(); return r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom; });
  });
  await page.screenshot({ path: info.outputPath('scan-focus.png') });
  console.log('pill over a card', hit);
  expect(hit).toBe(false);
});

/* STOCK2-5: .card brings no padding; .card-hd and .card-bd do. A card with plain content inside had its
 * text on the edge, clipped by the corner, on every station. Measured, on the rail and on a locked kiosk. */
async function cardsClear(page: Page, where: string) {
  await expect(page.locator('#ra-view .loading')).toHaveCount(0);
  await expect(page.locator('#ra-view .card').first()).toBeVisible();
  const bad = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#ra-view .card')].flatMap((c) => {
    if (c.querySelector(':scope > .card-hd, :scope > .card-bd, :scope > table') || !c.offsetHeight) return [];
    return parseFloat(getComputedStyle(c).paddingLeft) >= 12 ? [] : [(c.id || c.textContent || '').slice(0, 40)];
  }));
  expect(bad, where).toEqual([]);
  expect(await noSideScroll(page), where).toBe(true);
}
const atPick = (page: Page, id: string) => page.locator(`[data-job="${id}"]`).click();
async function staged(info: TestInfo) {
  const pickJ = await job(info), verifyJ = await job(info), mixJ = await job(info);
  await pick(verifyJ);
  await pick(mixJ);
  const vv = (await must('verifier', 'GET', `/v1/floor/jobs/${mixJ.floorJobId}/verify`)) as { lines: Array<{ floorLineId: string; targetMg: number }> };
  for (const l of vv.lines) await must('verifier', 'POST', `/v1/floor/jobs/${mixJ.floorJobId}/verify/lines/${l.floorLineId}`, { actualMg: l.targetMg, source: 'typed' });
  await must('verifier', 'POST', `/v1/floor/jobs/${mixJ.floorJobId}/verify/complete`, {});
  return { pickJ, verifyJ, mixJ };
}

test('STOCK2-5: every floor station keeps its card padding on the rail', async ({ page }, info) => {
  test.setTimeout(180_000);
  const { pickJ, verifyJ, mixJ } = await staged(info);
  for (const [role, nav, id] of [['picker', 'Pick', pickJ], ['verifier', 'Verify', verifyJ], ['mixer', 'Mix', mixJ]] as const) {
    await signIn(page, 'factory', role);
    await openNav(page, nav);
    await cardsClear(page, `${nav} list`);
    await atPick(page, id.floorJobId);
    await expect(page.locator('#fl-find')).toHaveCount(0); // the list has gone: the job is open
    await cardsClear(page, `${nav} job`);
    await page.screenshot({ path: info.outputPath(`rail-${role}.png`), fullPage: true });
    await openNav(page, 'Scan a lot');
    await cardsClear(page, `Scan a lot as ${role}`);
  }
  await signIn(page, 'factory', 'production');
  await openNav(page, 'Floor queue');
  await cardsClear(page, 'Floor queue');
  for (const [role, nav] of [['packing', 'Packing station'], ['logistics', 'Logistics station']] as const) {
    await signIn(page, 'factory', role);
    await openNav(page, nav);
    await cardsClear(page, nav);
  }
});

for (const [role, screen, station] of [['picker', 'floorpick', 'Pick 1'], ['verifier', 'floorverify', 'Verify 1'], ['mixer', 'floormix', 'Mix 1'], ['packing', 'packing', 'Packing 1'], ['logistics', 'logistics', 'Logistics 1']] as const) {
  test(`STOCK2-5: a kiosk locked to ${screen} keeps its card padding`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const { pickJ, verifyJ, mixJ } = await staged(info);
    await page.addInitScript((k) => { try { localStorage.setItem('ra.kiosk', JSON.stringify(k)); } catch (e) { /* about:blank */ } }, { station, screen, deviceId: 'walk' });
    await signIn(page, 'factory', role);
    await expect(page.locator('html')).toHaveClass(/ra-kiosk/);
    await cardsClear(page, `${screen} kiosk`);
    const id = { floorpick: pickJ.floorJobId, floorverify: verifyJ.floorJobId, floormix: mixJ.floorJobId }[screen as string];
    if (id) {
      await atPick(page, id);
      await expect(page.locator('#fl-find')).toHaveCount(0);
      await cardsClear(page, `${screen} kiosk job`);
    }
    await page.screenshot({ path: info.outputPath(`kiosk-${screen}.png`), fullPage: true });
  });
}
