/* Factory, STAGE-2-RP (c), STK-38: the two screens the mixer's reveal never had.
 *   1 The supervisor gives a batch to one mixer from the Floor queue, by person.
 *   2 The assigned mixer, on the Mix station, is shown the name of the material on the step they are
 *     doing: one name, beside its floor code, only while that step is current. The view is logged; the
 *     name is in no browser cache, no browser storage and not in the server's idempotency store.
 * The material's name is made up and is asserted ABSENT everywhere except the one element. */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { must, signedTypedE2e } from '../../harness/chain';
import { expectRefused, openNav, signIn, sql, uniq } from '../../harness/walk';

const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/** One coded material on a job that has been picked and verified by two people: it waits at Mix. */
async function jobAtMix(info: Parameters<Parameters<typeof test>[1]>[1]) {
  const fam = uniq('fam', info).toLowerCase();
  const name = `Zephyr Absolute ${letters()}`; // made up: no such material
  await must('admin', 'PUT', `/v1/floor/families/${fam}`, { familyName: 'Walk family', colourName: 'Tone' + letters(), colourHex: '#2F5DFF' });
  const mat = randomUUID();
  sql(`insert into masterdata.material (material_id, material_code, material_name, status) values ('${mat}', '${uniq('MX', info)}', '${name}', 'ACTIVE')`);
  const fc = (await must('procurement', 'POST', '/v1/floor/codes', { materialId: mat, familyCode: fam })) as { code: string };
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'g', 'gram', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const rb = randomUUID(), ib = randomUUID(), bin = randomUUID(), binCode = uniq('BX', info) + letters();
  sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${bin}', '${binCode}', 'ACTIVE')`);
  sql(`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values ('${rb}', '${mat}', '${uniq('RMX', info)}${letters()}', '2099-01-01', 'ACTIVE')`);
  sql(`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values ('${randomUUID()}', '${rb}', 'ACCEPT')`);
  sql(`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values ('${ib}', '${rb}', '${mat}', '${bin}', 1000, '${g}', 'ACTIVE')`);
  const lot = (await must('warehouse', 'POST', `/v1/floor/lots/${ib}/barcode`)) as { barcode: string };
  const order = randomUUID(), pl = randomUUID();
  sql(`insert into production.production_order (production_order_id, order_qty, uom_id, status) values ('${order}', 1, '${g}', 'INPROGRESS')`);
  sql(`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values ('${pl}', '${order}', 'ACTIVE')`);
  sql(`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values ('${randomUUID()}', '${order}', '${mat}', 20, false, '${g}', 'ACTIVE')`);
  sql(`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values ('${randomUUID()}', '${pl}', '${mat}', 20, '${g}', 'ACTIVE')`);
  const job = (await must('production', 'POST', '/v1/floor/jobs', { productionOrderId: order, steps: ['Stir 10 minutes'] })) as { floorJobId: string; jobNo: string };
  const pick = (await must('picker', 'GET', `/v1/floor/jobs/${job.floorJobId}/pick`)) as { lines: Array<{ floorLineId: string }> };
  for (const l of pick.lines) await must('picker', 'POST', `/v1/floor/jobs/${job.floorJobId}/pick/lines/${l.floorLineId}`, { bin: binCode, barcode: lot.barcode });
  await must('picker', 'POST', `/v1/floor/jobs/${job.floorJobId}/pick/complete`, { tote: uniq('TX', info) + letters() });
  const verify = (await must('verifier', 'GET', `/v1/floor/jobs/${job.floorJobId}/verify`)) as { lines: Array<{ floorLineId: string; targetMg: number }> };
  for (const l of verify.lines) await must('verifier', 'POST', `/v1/floor/jobs/${job.floorJobId}/verify/lines/${l.floorLineId}`, { actualMg: l.targetMg, ...(await signedTypedE2e(l.targetMg)) });
  await must('verifier', 'POST', `/v1/floor/jobs/${job.floorJobId}/verify/complete`);
  expect(sql(`select stage from production.floor_job where floor_job_id='${job.floorJobId}'`)).toBe('MIX');
  return { ...job, code: fc.code, name };
}
const mixer = () => ({
  id: sql(`select user_id from iam.user_master where email='mixer@rawaroma.local'`),
  name: sql(`select user_name from iam.user_master where email='mixer@rawaroma.local'`),
});
async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll').toBe(true);
}

test('Floor queue: a supervisor assigns the batch to a mixer by person, and the batch then stays with them', async ({ page }, info) => {
  const j = await jobAtMix(info);
  const m = mixer();
  expect(sql(`select coalesce(mixer_assigned_to, 'nobody') from production.floor_job where floor_job_id='${j.floorJobId}'`)).toBe('nobody');

  await signIn(page, 'factory', 'production');
  await openNav(page, 'Floor queue');
  await page.locator(`[data-assign="${j.floorJobId}"]`).click();
  const sheet = page.locator('[data-ask="userId"]');
  await expect(sheet).toBeVisible();
  await expect(page.getByText('No mixer is assigned yet.')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(j.name); // the supervisor's control names people, never a material
  await noHorizontalScroll(page);
  await sheet.selectOption({ label: m.name });
  await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText(`${j.jobNo} is assigned to ${m.name}.`)).toBeVisible();
  await expect.poll(() => sql(`select mixer_assigned_to from production.floor_job where floor_job_id='${j.floorJobId}'`)).toBe(m.id);
  expect(sql(`select mixer_assigned_by is not null and mixer_assigned_dt is not null from production.floor_job where floor_job_id='${j.floorJobId}'`)).toBe('t');

  // The control now says who holds it.
  await page.locator(`[data-assign="${j.floorJobId}"]`).click();
  await expect(page.getByText(new RegExp(`Assigned to ${m.name} since `))).toBeVisible();
  await page.keyboard.press('Escape');

  // Once the mixer has done a step, the batch stays with them: the control says so and offers no change.
  await must('mixer', 'POST', `/v1/floor/jobs/${j.floorJobId}/mix/steps/1`);
  await openNav(page, 'Floor queue');
  await page.locator(`[data-assign="${j.floorJobId}"]`).click();
  await expect(page.getByText('Mixing has started, so this batch stays with its mixer.')).toBeVisible();
  await expect(page.locator('[data-ask="userId"]')).toHaveCount(0);
  await noHorizontalScroll(page);
});

test('Mix station: the assigned mixer sees the current step\'s one name, logged, never cached, gone when the step is done', async ({ page }, info) => {
  const j = await jobAtMix(info);
  const m = mixer();

  // Nobody is assigned: the mixer is refused in a sentence, and that is not a view.
  await signIn(page, 'factory', 'mixer');
  await openNav(page, 'Mix');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await expect(page.locator('#ra-view')).toContainText('Stir 10 minutes');
  await expect(page.locator('#ra-view')).not.toContainText(j.name);
  await page.locator('#fl-rv').click();
  await expect(page.locator('#fl-err')).toContainText('has no assigned mixer');
  await expect(page.locator('#fl-reveal')).toBeHidden();
  expect(sql(`select count(*) from production.floor_mix_reveal where floor_job_id='${j.floorJobId}'`)).toBe('0');

  // A supervisor assigns it (the control is walked above); the mixer asks again.
  await must('production', 'POST', `/v1/floor/jobs/${j.floorJobId}/mix/assign`, { userId: m.id });
  await page.locator('#fl-rv').click();
  const box = page.locator('#fl-reveal');
  await expect(box).toBeVisible();
  await expect(box).toContainText(j.name);
  await expect(box).toContainText(j.code);
  await expect(box).toContainText('until you press Done');
  await noHorizontalScroll(page);
  // logged: who, which step, and never the name
  await expect.poll(() => sql(`select count(*) from production.floor_mix_reveal where floor_job_id='${j.floorJobId}' and step_seq=1 and revealed_to='${m.id}'`)).toBe('1');
  expect(sql(`select count(*) from production.floor_mix_reveal r where r.floor_job_id='${j.floorJobId}' and to_jsonb(r)::text like '%${j.name}%'`)).toBe('0');

  // never cached: not by the service worker, not in browser storage, not in the server's idempotency store
  const kept = await page.evaluate(async (name) => {
    const reg = await navigator.serviceWorker.getRegistration();
    const hits: string[] = [];
    for (const key of await caches.keys()) {
      const c = await caches.open(key);
      for (const req of await c.keys()) {
        if (/\/rpc|\/v1\//.test(new URL(req.url).pathname)) hits.push('cached url ' + req.url);
        const res = await c.match(req);
        const body = res ? await res.clone().text().catch(() => '') : '';
        if (body.includes(name)) hits.push('cached body ' + req.url);
      }
    }
    for (const store of [localStorage, sessionStorage]) for (let i = 0; i < store.length; i++) {
      const k = store.key(i)!; if ((k + (store.getItem(k) ?? '')).includes(name)) hits.push('storage ' + k);
    }
    return { worker: !!reg, caches: (await caches.keys()).length, hits };
  }, j.name);
  expect(kept.worker, 'the service worker is registered, so the cache check means something').toBe(true);
  expect(kept.hits).toEqual([]);
  expect(sql(`select count(*) from platform.idempotency_key where response::text like '%${j.name}%'`)).toBe('0');

  // a tab that is hidden loses the name; asking again is a second, logged view
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(box).toBeHidden();
  await expect(page.locator('#ra-view')).not.toContainText(j.name);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); });
  await page.locator('#fl-rv').click();
  await expect(box).toContainText(j.name);
  await expect.poll(() => sql(`select count(*) from production.floor_mix_reveal where floor_job_id='${j.floorJobId}'`)).toBe('2');

  // the step is confirmed: the name is gone from the screen and the server no longer serves it
  await page.locator('[data-step="1"]').click();
  await expect(page.locator('[data-step="2"]')).toBeVisible();
  await expect(page.locator('#ra-view')).not.toContainText(j.name);
  await expect(page.locator('#fl-rv')).toHaveCount(0); // step 2 is a production note: it adds no material, so there is nothing to show
  expect(sql(`select count(*) from production.floor_mix_reveal where floor_job_id='${j.floorJobId}'`)).toBe('2');

  // someone who is not the assigned mixer never gets a name, by the screen or by the route
  await signIn(page, 'factory', 'picker');
  await expectRefused(page, 'POST', `/v1/floor/jobs/${j.floorJobId}/mix/reveal`, {});
  await signIn(page, 'factory', 'production');
  await expectRefused(page, 'POST', `/v1/floor/jobs/${j.floorJobId}/mix/reveal`, {});
});
