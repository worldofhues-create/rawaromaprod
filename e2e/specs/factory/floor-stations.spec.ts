/* Factory: the floor (PROD-A, production-floor plan P1). Rules screen, floor colours, and one job
 * walked Picker -> Verifier -> Mixer by three different people, with the refusals a person meets. */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { must } from '../../harness/chain';
import { expectRefused, factoryCall, openNav, signIn, sql, uniq } from '../../harness/walk';

const letters = () => Array.from({ length: 7 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/** One coded material with two released lots (FEFO: `soon` first), on a pick list of `grams`. */
async function floorJob(info: Parameters<Parameters<typeof test>[1]>[1], grams = 125.5) {
  const fam = uniq('fam', info).toLowerCase();
  const colour = 'Tone' + letters();
  await must('admin', 'PUT', `/v1/floor/families/${fam}`, { familyName: 'Walk family', colourName: colour, colourHex: '#E8C547' });
  const mat = randomUUID();
  sql(`insert into masterdata.material (material_id, material_code, material_name, status) values ('${mat}', '${uniq('MW', info)}', 'Walk oil', 'ACTIVE')`);
  const fc = (await must('procurement', 'POST', '/v1/floor/codes', { materialId: mat, familyCode: fam })) as { code: string };
  sql(`insert into platform.uom_master (uom_id, uom_code, uom_name, status) values ('${randomUUID()}', 'g', 'gram', 'ACTIVE') on conflict do nothing`);
  const g = sql(`select uom_id from platform.uom_master where uom_code='g'`);
  const lot = async (expiry: string) => {
    const rb = randomUUID(), ib = randomUUID(), bin = randomUUID(), binCode = uniq('BW', info) + letters();
    sql(`insert into location.bin_master (bin_id, bin_code, status) values ('${bin}', '${binCode}', 'ACTIVE')`);
    sql(`insert into inventory.rm_batch_master (rm_batch_id, material_id, batch_number, expiry_date, status) values ('${rb}', '${mat}', '${uniq('RMW', info)}${letters()}', '${expiry}', 'ACTIVE')`);
    sql(`insert into quality.qc_inspections (qc_inspection_id, rm_batch_id, overall_result) values ('${randomUUID()}', '${rb}', 'ACCEPT')`);
    sql(`insert into inventory.inventory_batch (inventory_batch_id, rm_batch_id, material_id, storage_location_id, quantity_on_hand, uom_id, status) values ('${ib}', '${rb}', '${mat}', '${bin}', 1000, '${g}', 'ACTIVE')`);
    const r = (await must('warehouse', 'POST', `/v1/floor/lots/${ib}/barcode`)) as { barcode: string };
    return { barcode: r.barcode, bin: binCode };
  };
  const soon = await lot('2098-01-01'), late = await lot('2099-01-01');
  const order = randomUUID(), pl = randomUUID();
  sql(`insert into production.production_order (production_order_id, order_qty, uom_id, status) values ('${order}', 1, '${g}', 'INPROGRESS')`);
  sql(`insert into production.material_pick_list (material_pick_list_id, production_order_id, status) values ('${pl}', '${order}', 'ACTIVE')`);
  sql(`insert into production.production_order_ingredients (production_order_ingredient_id, production_order_id, material_id, required_qty, issued_qty, uom_id, status) values ('${randomUUID()}', '${order}', '${mat}', ${grams}, false, '${g}', 'ACTIVE')`);
  sql(`insert into production.material_pick_list_items (material_pick_list_item_id, material_pick_list_id, material_id, picked_qty, uom_id, status) values ('${randomUUID()}', '${pl}', '${mat}', ${grams}, '${g}', 'ACTIVE')`);
  const job = (await must('production', 'POST', '/v1/floor/jobs', { productionOrderId: order, steps: ['Stir 10 minutes'] })) as { floorJobId: string; jobNo: string };
  return { ...job, code: fc.code, colour, soon, late };
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll').toBe(true);
}

test('Rules: the admin tests a draft (match and HOLD), publishes it with a reason, and the floor cannot publish', async ({ page }) => {
  await signIn(page, 'factory', 'admin');
  await openNav(page, 'Rules');
  await expect(page.locator('#ra-view')).toContainText('receiving.shortfall');
  await page.locator('[data-pol="planning.cover"]').click();
  // A shared database: earlier walks may have published rules here, so the new rule is the last one.
  await expect(page.locator('#fl-ar')).toBeVisible(); // the editor has drawn the version in force
  const had = await page.locator('[data-delr]').count();
  for (let i = had - 1; i >= 0; i--) await page.locator(`[data-delr="${i}"]`).click();
  await page.locator('#fl-ar').click();
  await page.locator('[data-addc="0"]').click();
  await page.locator('[data-f="field"][data-r="0"][data-c="0"]').fill('seasonal');
  await page.locator('[data-f="value"][data-r="0"][data-c="0"]').fill('yes');
  await page.locator('[data-f="then"][data-r="0"]').fill('{"weeks":8}');
  if (await page.locator('#fl-hd').isChecked()) await page.locator('#fl-hd').uncheck();
  await page.locator('#fl-ctx').fill('{"seasonal":"yes"}');
  await page.locator('#fl-test').click();
  await expect(page.locator('#fl-tout')).toContainText('Result: {"weeks":8}');
  await page.locator('#fl-ctx').fill('{"seasonal":"no"}');
  await page.locator('#fl-test').click();
  await expect(page.locator('#fl-tout')).toContainText('HOLD');
  const before = Number(sql(`select max(version) from platform.policy_version where policy_key='planning.cover'`));
  await page.locator('#fl-pub').click();
  await expect(page.locator('#fl-perr')).toContainText('why');
  await page.locator('#fl-why').fill('Walk: seasonal cover');
  await page.locator('#fl-pub').click();
  await expect.poll(() => Number(sql(`select max(version) from platform.policy_version where policy_key='planning.cover'`))).toBe(before + 1);
  await noHorizontalScroll(page);
  await signIn(page, 'factory', 'picker');
  await expect(page.locator('#ra-side .who small')).toHaveText('Picker');
  await expectRefused(page, 'POST', '/v1/policies/planning.cover/versions', { body: { rules: [], hasDefault: true, defaultValue: 1 }, reason: 'x' });
});

test('Pick -> Verify -> Mix by three people: FEFO and wrong-scan refusals, tolerance, step order, separation of duties, labels', async ({ page }, info) => {
  const j = await floorJob(info);
  const tote = uniq('T', info);

  // 1 Picker
  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Pick');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await expect(page.locator('#ra-view')).toContainText(j.code);
  await expect(page.locator('#ra-view')).toContainText(j.colour);
  await expect(page.locator('#ra-view')).toContainText(j.soon.bin);
  await expect(page.locator('#ra-view')).not.toContainText('125');
  await noHorizontalScroll(page);
  await page.locator('#fl-bin').fill(j.late.bin);
  await page.locator('#fl-lot').fill(j.late.barcode);
  await page.locator('#fl-tick').click();
  await expect(page.locator('#fl-err')).toContainText('first (it expires first');
  await page.locator('#fl-bin').fill('WRONG');
  await page.locator('#fl-lot').fill(j.soon.barcode);
  await page.locator('#fl-tick').click();
  await expect(page.locator('#fl-err')).toContainText('Wrong bin');
  await page.locator('#fl-bin').fill(j.soon.bin);
  await page.locator('#fl-tick').click();
  await page.locator('#fl-tote2').fill(tote);
  const popup = page.waitForEvent('popup');
  await page.locator('#fl-finish').click();
  const label = await popup;
  await expect(label.locator('h1')).toContainText('PICKED');
  await expect(label.locator('body')).toContainText(j.jobNo);
  await label.close();
  await expect.poll(() => sql(`select stage from production.floor_job where floor_job_id='${j.floorJobId}'`)).toBe('VERIFY');
  expect(sql(`select count(*) from production.material_issue where production_order_id=(select production_order_id from production.floor_job where floor_job_id='${j.floorJobId}')`)).toBe('1');
  // the picker cannot verify their own pick, even by calling the route
  await expectRefused(page, 'GET', `/v1/floor/jobs/${j.floorJobId}/verify`);

  // 2 Verifier
  await signIn(page, 'factory', 'verifier');
  await openNav(page, 'Verify');
  await page.locator('#fl-tote').fill(tote);
  await page.locator('#fl-go').click();
  await expect(page.locator('#ra-view')).toContainText('target 125.50 g ± 1.25 g');
  await page.locator('#fl-wt').fill('127');
  await page.locator('#fl-wtick').click();
  await expect(page.locator('#fl-err')).toContainText('outside');
  // STOCK2-1: over the pick is held for a supervisor; at or under it the verifier ticks alone.
  await page.locator('#fl-wt').fill('125.6');
  await page.locator('#fl-wtick').click();
  await expect(page.locator('#ra-view')).toContainText('held for a supervisor');
  await page.locator('#fl-wt').fill('125.4');
  await page.locator('#fl-wtick').click();
  await expect(page.locator('#ra-view')).toContainText('125.4 g typed');
  await noHorizontalScroll(page);
  const vpop = page.waitForEvent('popup');
  await page.locator('#fl-vdone').click();
  await (await vpop).close();
  await expect.poll(() => sql(`select stage from production.floor_job where floor_job_id='${j.floorJobId}'`)).toBe('MIX');
  expect(sql(`select string_agg(status, ',' order by w.created_dt) from production.weighing_record w join production.floor_job f on f.mixing_session_id = w.secure_mixing_session_id where f.floor_job_id='${j.floorJobId}'`)).toBe('OUT_OF_TOLERANCE,ACCEPTED');

  // 3 Mixer
  await signIn(page, 'factory', 'mixer');
  await openNav(page, 'Mix');
  await page.locator(`[data-job="${j.floorJobId}"]`).click();
  await expect(page.locator('#ra-view')).toContainText('Stir 10 minutes');
  const r = await factoryCall(page, 'POST', `/v1/floor/jobs/${j.floorJobId}/mix/steps/2`);
  expect(r.status).toBe(409);
  expect(r.json.error.message).toContain('Do step 1 first');
  await page.locator('[data-step="1"]').click();
  await page.locator('[data-step="2"]').click();
  await noHorizontalScroll(page);
  const mpop = page.waitForEvent('popup');
  await page.locator('#fl-mdone').click();
  const ml = await mpop;
  await expect(ml.locator('h1')).toContainText('MIXED');
  await ml.close();
  await expect.poll(() => sql(`select stage from production.floor_job where floor_job_id='${j.floorJobId}'`)).toBe('DONE');
  const batch = sql(`select batch_no from production.floor_job where floor_job_id='${j.floorJobId}'`);
  expect(sql(`select count(*) from production.oil_batch_master where batch_number='${batch}'`)).toBe('1');
});

test('Scan a lot: the floor sees code, colour, bin and the hazard line, never the material', async ({ page }, info) => {
  const j = await floorJob(info, 5);
  await signIn(page, 'factory', 'picker');
  await openNav(page, 'Scan a lot');
  await page.locator('#fl-sci').fill(j.soon.barcode);
  await page.locator('#fl-scgo').click();
  await expect(page.locator('#fl-sco')).toContainText(j.code);
  await expect(page.locator('#fl-sco')).toContainText('Classification pending: handle as hazardous');
  await expect(page.locator('#fl-sco')).not.toContainText('Walk oil');
  await noHorizontalScroll(page);
});
