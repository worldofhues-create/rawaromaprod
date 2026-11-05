/* Lane pf-c (production floor P3/P4): the floor screens walked as a person, at 1440 and 375.
 *   Devices: add a printer -> 6-digit code -> the print agent pairs -> Online; add a TV -> /pair.html
 *   with the code -> the floor board. Packing: a QC-approved lot -> unit (weight typed, sealed) ->
 *   carton -> carton weight -> finish (labels printed in the browser fallback). Logistics: carton
 *   check -> documents -> AWB -> handover; the database is read back each time. Maceration, Couriers
 *   and the Floor board open and say what they hold. Nothing overflows the phone width.
 * NOT WALKED HERE: a physical printer or scale (tools/print-agent and the scale parser are covered
 * by backend tests), ALEMBIC receiving Dispatched (not in this stack). */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { URLS } from '../../harness/config.mjs';
import { openNav, signIn, sql, uniq } from '../../harness/walk';

async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
  expect(over, 'no horizontal page scroll').toBeLessThanOrEqual(1);
}
/** The browser-print fallback opens a print window: a person prints and closes it. */
function closePrintWindows(page: Page) { page.context().on('page', (p) => { if (p !== page) p.close().catch(() => {}); }); }

test('Devices: add a printer, pair it with the code, it shows Online; a TV pairs at /pair.html and shows the board', async ({ page }, info) => {
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Devices');
  const station = uniq('Pack-', info);
  await page.locator('#fo-kind').selectOption('label_printer');
  await page.locator('#fo-station').fill(station);
  await page.locator('#fo-name').fill('Zebra ZD421');
  await page.locator('#fo-add button[type=submit]').click();
  await expect(page.locator('#fo-pair')).toContainText(station);
  const code = (await page.locator('#fo-pair').getByText(/^\d{6}$/).textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);
  await expect(page.locator('#fo-pair svg')).toBeVisible(); // the QR
  expect(sql(`select count(*) from platform.device_pairing p join platform.device_master d using (device_id) where d.station='${station}' and p.code_hash='${code}'`)).toBe('0'); // stored hashed
  // The print agent pairs with the code.
  const paired = await page.request.post(`${URLS.factory}/v1/device-agent/pair`, { data: { code } });
  expect(paired.ok()).toBeTruthy();
  expect(sql(`select status from platform.device_master where station='${station}'`)).toBe('active');
  await openNav(page, 'Print queue'); // leave and come back: the list is read again
  await openNav(page, 'Devices');
  await expect(page.locator('tr', { hasText: station })).toContainText('Online');
  await noSideScroll(page);

  // A TV.
  const tvStation = uniq('TV-', info);
  await page.locator('#fo-kind').selectOption('display');
  await page.locator('#fo-station').fill(tvStation);
  await page.locator('#fo-name').fill('Floor TV');
  await page.locator('#fo-add button[type=submit]').click();
  await expect(page.locator('#fo-pair')).toContainText(tvStation); // the TV's own code, not the printer's
  const tvCode = (await page.locator('#fo-pair').getByText(/^\d{6}$/).textContent())!.trim();
  const tv = await page.context().newPage();
  await tv.goto(`${URLS.factory}/pair.html#code=${tvCode}`);
  await expect(tv.locator('#code')).toHaveValue(tvCode);
  await tv.getByRole('button', { name: 'Pair' }).click();
  await expect(tv.locator('#board')).toContainText('Floor queue');
  await expect(tv.locator('#board')).toContainText('Maceration');
  await expect(tv.locator('#board')).toContainText('QC backlog');
  expect(sql(`select status from platform.device_master where station='${tvStation}'`)).toBe('active');
  await tv.close();
});

test('Packing then Logistics: unit, carton, finish, carton check, documents, AWB, handover', async ({ page }, info) => {
  closePrintWindows(page);
  const so = randomUUID(), fg = randomUUID(), product = randomUUID(), sku = randomUUID(), soNo = uniq('SO', info), courier = `dl${Date.now().toString(36)}`;
  sql(`insert into sales.sales_order (sales_order_id, so_number, order_date, status) values ('${so}', '${soNo}', current_date, 'CONFIRMED');
       insert into packaging.product_master (product_id, product_code, product_name, status) values ('${product}', 'P-${soNo}', 'Oud Noir', 'ACTIVE');
       insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status) values ('${sku}', '${product}', 'SKU-${soNo}', '10 ml', 'ACTIVE');
       insert into packaging.finished_good_batch_master (finished_good_batch_id, product_sku_id, batch_number, produced_qty, status) values ('${fg}', '${sku}', 'FG-${soNo}', 20, 'ACTIVE');
       insert into packaging.packaging_qc (packaging_qc_id, finished_good_batch_id, overall_result, status) values ('${randomUUID()}', '${fg}', 'PASS', 'ACTIVE');
       insert into sales.courier_connector (provider, display_name) values ('${courier}', 'Walk Courier')`);
  await signIn(page, 'factory', 'owner');
  await openNav(page, 'Packing station');
  await page.locator('#fo-pk-so').fill(so);
  await page.locator('#fo-pk-lots').fill(fg);
  await page.getByRole('button', { name: 'Start packing' }).click();
  await expect(page.getByText('Fill a unit')).toBeVisible();
  await noSideScroll(page);
  await page.locator('#fo-u-t').fill('10');
  await page.locator('#fo-u-tol').fill('0.1');
  await page.locator('#fo-u-w').fill('10.2');
  await page.locator('#fo-u-seal').check();
  await page.getByRole('button', { name: 'Record unit + print label' }).click();
  await expect(page.locator('.toast, [role=status]').filter({ hasText: /tolerance/ }).first()).toBeVisible(); // 10.2 g is outside 10 ± 0.1
  await page.locator('#fo-u-w').fill('10.05');
  await page.getByRole('button', { name: 'Record unit + print label' }).click();
  await expect(page.locator('tr', { hasText: 'not in a carton' })).toBeVisible();
  const unitCode = sql(`select unit_code from sales.shipment_unit u join sales.shipment s using (shipment_id) where s.sales_order_id='${so}'`);
  expect(sql(`select net_mg || ' ' || weight_source from sales.shipment_unit where unit_code='${unitCode}'`)).toBe('10050 typed');
  expect(sql(`select status from platform.print_job where label_kind='customer' and subject_ref='${unitCode}'`)).toBe('printed'); // browser fallback
  await page.getByRole('button', { name: 'Open next carton' }).click();
  await page.locator('#fo-scan-u').fill(unitCode);
  await page.getByRole('button', { name: 'Add to carton' }).click();
  await expect(page.locator('tr', { hasText: 'in carton 1' })).toBeVisible();
  await page.locator('#fo-c-w').fill('60');
  await page.getByRole('button', { name: 'Weigh + close carton' }).click();
  await expect(page.locator('tr', { hasText: 'CLOSED' })).toBeVisible();
  await page.getByRole('button', { name: /Finish packing/ }).click();
  await expect(page.locator('.chip', { hasText: 'PACKED' })).toBeVisible();
  expect(sql(`select status || ' ' || carton_count from sales.shipment where sales_order_id='${so}'`)).toBe('PACKED 1');

  await openNav(page, 'Logistics station');
  await page.locator('tr', { hasText: soNo }).getByRole('button', { name: 'Work on it' }).click();
  await noSideScroll(page);
  const carton = sql(`select carton_code from sales.shipment_carton c join sales.shipment s using (shipment_id) where s.sales_order_id='${so}'`);
  await page.locator('#fo-lg-cc').fill(carton);
  await page.getByRole('button', { name: 'Check carton' }).click();
  await expect(page.getByText(/1 of 1 cartons scanned/)).toBeVisible();
  await page.getByRole('button', { name: 'Generate + print documents' }).click();
  await expect(page.getByText(/INVOICE \(blank: invoiceNumber/)).toBeVisible();
  const awb = `WALK${Date.now()}`;
  await page.locator('#fo-lg-cr').selectOption(courier);
  await page.locator('#fo-lg-awbv').fill(awb);
  await page.getByRole('button', { name: /Save AWB/ }).click();
  await expect(page.locator('tr', { hasText: soNo })).toContainText(awb);
  await page.locator('#fo-lg-to').fill('Ravi');
  await page.getByRole('button', { name: 'Handed over' }).click();
  await expect(page.locator('tr', { hasText: soNo })).toHaveCount(0);
  expect(sql(`select status || ' ' || awb || ' ' || handed_over_to from sales.shipment where sales_order_id='${so}'`)).toBe(`HANDED_OVER ${awb} Ravi`);
  expect(Number(sql(`select count(*) from sales.dispatch_document d join sales.shipment s on s.dispatch_id = d.dispatch_id where s.sales_order_id='${so}'`))).toBeGreaterThanOrEqual(3);
});

test('Maceration, Couriers, Print queue and the Floor board open and say what they hold', async ({ page }) => {
  await signIn(page, 'factory', 'owner');
  for (const [nav, text] of [['Maceration', 'Macerating now'], ['Couriers', 'Add a courier'], ['Print queue', 'labels for one station'], ['Floor board', 'Floor queue']] as const) {
    await openNav(page, nav);
    // Inside a card, not anywhere on the page: since lanes A+C merged, 'Floor queue' is also lane A's nav
    // item, and at 375 that rail entry sits hidden in the closed drawer, so .first() found it and never
    // looked at the board. The board's own heading is what this asserts.
    await expect(page.locator('.card').getByText(text).first()).toBeVisible();
    await noSideScroll(page);
  }
});
