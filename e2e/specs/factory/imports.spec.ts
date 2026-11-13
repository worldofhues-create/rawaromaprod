/* Factory: import from a sheet (IMPORT-RP). The panel on the lists that have a template, at both widths:
 * template download, upload, preview, import, the same file again, a file with problems, the rows to
 * fix, valid rows only, the export of what is on file and a purchase price typed on screen. Every
 * name and price is made up. */
import { expect, test, type Page } from '@playwright/test';
import { master } from '../../harness/chain';
import { openNav, signIn, sql, uniq } from '../../harness/walk';

const csv = (name: string, rows: string[][]) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(rows.map((r) => r.join(',')).join('\n') + '\n') });
/** Nothing on the page is wider than the screen: the panel reads at phone width without a sideways scroll. */
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const sheet = page.getByRole('dialog');
  expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
}

test('procurement imports ingredients from a sheet on Materials, and records purchase prices', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await master();
  const a = uniq('IMP-A-', info), b = uniq('IMP-B-', info);
  await signIn(page, 'factory', 'procurement');
  await openNav(page, 'Materials');
  await page.locator('#ra-import').click();
  const sheet = page.getByRole('dialog', { name: 'Import ingredients, dilutions and purchase prices' });
  // Only the kinds this person may run, in the screen's order.
  await expect(sheet.getByRole('tab')).toHaveText(['Ingredients', 'Dilutions', 'Material purchase prices']);

  // The template is a real download.
  const [template] = await Promise.all([page.waitForEvent('download'), sheet.locator('[data-act="template-xlsx"]').click()]);
  expect(template.suggestedFilename()).toBe('ingredients-template.xlsx');

  // Upload: a preview, and nothing written yet.
  const good = csv('ingredients.csv', [['Code', 'Name', 'Family'], [a, `Made-up material ${a}`, 'citrus'], [b, `Made-up material ${b}`, '']]);
  await sheet.locator('[data-act="file"]').setInputFiles(good);
  await expect(sheet.locator('.ra-imp-counts')).toContainText('2 to import');
  await expect(sheet.locator('.ra-imp-rows li.ra-imp-row')).toHaveCount(2);
  expect(sql(`select count(*) from masterdata.material where material_code in ('${a}','${b}')`)).toBe('0');
  await fits(page);
  await page.screenshot({ path: `e2e/.run/shots/imports-preview-${info.project.name}.png`, fullPage: false });

  await sheet.locator('[data-act="commit"]').click();
  await expect(sheet.locator('.ra-imp-done')).toHaveText('2 rows were imported.');
  expect(sql(`select count(*) from masterdata.material where material_code in ('${a}','${b}')`)).toBe('2');
  expect(sql(`select count(*) from masterdata.floor_code c join masterdata.material m using (material_id) where m.material_code='${a}'`)).toBe('1');
  await expect(sheet.locator('.ra-imp-history')).toContainText('Earlier imports');

  // The same file again changes nothing, and says so.
  await sheet.locator('[data-act="file"]').setInputFiles(good);
  await expect(sheet.locator('.ra-imp-preview')).toContainText('Already imported');
  await expect(sheet.locator('[data-act="commit"]')).toHaveCount(0);
  expect(sql(`select count(*) from masterdata.material where material_code in ('${a}','${b}')`)).toBe('2');

  // A file with problems: each named, all-or-nothing refused in words, the rows to fix, then valid rows only.
  const c = uniq('IMP-C-', info);
  await sheet.locator('[data-act="file"]').setInputFiles(csv('bad.csv', [['Code', 'Name', 'CAS number', 'Hazard class'], [c, `Made-up material ${c}`, '', ''], ['', 'TOTAL (g)', '', ''], [a, 'Another name', '64-17-6', '3']]));
  await expect(sheet.locator('.ra-imp-counts')).toContainText('2 problems');
  await expect(sheet.locator('.ra-imp-rows')).toContainText('is a sheet\'s total row, not a material');
  await expect(sheet.locator('.ra-imp-rows')).toContainText('is not a CAS number');
  await expect(sheet.locator('.ra-imp-rows')).toContainText('A hazard class needs its source');
  await expect(sheet.locator('[data-act="commit"]')).toBeDisabled();
  await expect(sheet.locator('.ra-imp-why')).toContainText('2 rows have a problem, so nothing is imported');
  const [fix] = await Promise.all([page.waitForEvent('download'), sheet.locator('[data-act="problems-xlsx"]').click()]);
  expect(fix.suggestedFilename()).toBe('ingredients-rows-to-fix.xlsx');
  await fits(page);
  await page.screenshot({ path: `e2e/.run/shots/imports-problems-${info.project.name}.png`, fullPage: false });
  await sheet.getByLabel(/Import the 1 valid row only/).check();
  await sheet.locator('[data-act="commit"]').click();
  await expect(sheet.locator('.ra-imp-done')).toHaveText('1 row was imported, 2 rows were left out.');
  expect(sql(`select count(*) from masterdata.material where material_code='${c}'`)).toBe('1');

  // Purchase prices: the export of what is on file is a download; a filled row is recorded with its fact.
  await sheet.getByRole('tab', { name: 'Material purchase prices' }).click();
  const [onFile] = await Promise.all([page.waitForEvent('download'), sheet.locator('[data-act="export"]').click()]);
  expect(onFile.suggestedFilename()).toBe('material-purchase-prices-on-file.xlsx');
  await sheet.locator('[data-act="file"]').setInputFiles(csv('prices.csv', [['Material code', 'Unit', 'List purchase price (Rs per unit)', 'Purchase discount %', 'Effective from'], [a, 'kg', '1250.50', '5', '01/11/2026'], [b, 'kg', '', '', '']]));
  await expect(sheet.locator('.ra-imp-counts')).toContainText('1 to import');
  await expect(sheet.locator('.ra-imp-rows')).toContainText('Net Rs 1187.98 per kg');
  await expect(sheet.locator('.ra-imp-rows')).toContainText('No price is given, so nothing changes');
  await sheet.locator('[data-act="commit"]').click();
  await expect(sheet.locator('.ra-imp-done')).toHaveText('1 row was imported.');
  expect(sql(`select p.net_price_paise from procurement.material_purchase_price p join masterdata.material m using (material_id) where m.material_code='${a}'`)).toBe('118798');
  expect(sql(`select count(*) from bridge.outbox where type='material.cost.recorded' and payload->>'material_code'='${a}'`)).toBe('1');
  await sheet.getByRole('button', { name: 'Close' }).click();

  // One price, typed: the same function. A second figure for the same day is refused in the sheet's words.
  await page.locator('#ra-price').click();
  const form = page.getByRole('dialog', { name: 'Record a purchase price' });
  await form.locator('#ra-price-code').fill(b);
  await form.locator('#ra-price-list').fill('80');
  await form.locator('#ra-price-unit').fill('kg');
  await form.locator('#ra-price-from').fill('2026-11-10');
  await form.getByRole('button', { name: 'Record the price' }).click();
  await expect(page.locator('.toast')).toContainText('Price recorded: net Rs 80.00');
  await page.locator('#ra-price').click();
  await form.locator('#ra-price-code').fill(b);
  await form.locator('#ra-price-list').fill('95');
  await form.locator('#ra-price-unit').fill('kg');
  await form.locator('#ra-price-from').fill('2026-11-10');
  await form.getByRole('button', { name: 'Record the price' }).click();
  await expect(form.locator('#ra-price-err')).toContainText('never rewritten: give a later effective date');
  expect(sql(`select count(*) from procurement.material_purchase_price p join masterdata.material m using (material_id) where m.material_code='${b}'`)).toBe('1');
  expect(errors).toEqual([]);
});

test('the button is drawn only for a person who may run a kind on that screen', async ({ page }) => {
  // Warehouse may import stock adjustments, and may not open raw stock: one screen has the button, the other does not.
  await signIn(page, 'factory', 'warehouse');
  await openNav(page, 'Stock adjustments');
  await expect(page.locator('#ra-import')).toBeVisible();
  await page.locator('#ra-import').click();
  const sheet = page.getByRole('dialog', { name: 'Import stock adjustments' });
  await expect(sheet.getByRole('tab')).toHaveCount(0); // one kind: no chooser
  await expect(sheet.locator('[data-act="template-xlsx"]')).toBeVisible();
  await expect(sheet.locator('[data-act="export"]')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await openNav(page, 'Raw material batches');
  await page.waitForTimeout(800); // the kinds answer is cached from the screen before; give a late draw its chance
  await expect(page.locator('#ra-import')).toHaveCount(0);
  await expect(page.locator('#ra-price')).toHaveCount(0);
});
