/* Vault: recipes from a spreadsheet (IMPORT-RP). The formulator sees the panel on Recipes needed and
 * uploads a made-up recipe; it is sealed under their name and waits for a second person. The approver
 * does not see the panel at all. Nothing on the screen or in the job names an ingredient or a quantity. */
import { expect, test } from '@playwright/test';
import { master, must, rp, until } from '../../harness/chain';
import { signIn, sql, uniq, vaultGo } from '../../harness/walk';

test('a formulator uploads a recipe from a sheet; it is sealed and sent for review, and the import keeps none of it', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await master(); // CH-RM-1, pushed to the Vault's material list on a timer
  const code = uniq('F-IMP-', info);
  await must('formulator', 'POST', '/v1/formulas', { formulaCode: code, formulaName: `Made-up ${code}` }, { vault: true });
  await until('the material to reach the Vault', async () => ((await rp('formulator', 'GET', '/v1/vault/materials?q=CH-RM-1', undefined, { vault: true })).body ?? []).length > 0);

  await signIn(page, 'vault', 'formulator');
  await vaultGo(page, '#/recipes', 'Recipes needed');
  const card = page.locator('.ra-imp-card');
  await expect(card.getByRole('heading', { name: 'Upload recipes from a spreadsheet' })).toBeVisible();
  await expect(card.locator('[data-act="export"]')).toHaveCount(0); // a formula is never exported from here
  const [template] = await Promise.all([page.waitForEvent('download'), card.locator('[data-act="template-xlsx"]').click()]);
  expect(template.suggestedFilename()).toBe('formulas-template.xlsx');

  const head = 'Formula code,Version,Line number,Ingredient code,Parts by weight';
  const file = (name: string, lines: string[]) => ({ name, mimeType: 'text/csv', buffer: Buffer.from([head, ...lines].join('\n') + '\n') });
  // A recipe that does not total: refused in words that name no ingredient and no quantity.
  await card.locator('[data-act="file"]').setInputFiles(file('short.csv', [`${code},1,1,CH-RM-1,99.96`]));
  await expect(card.locator('.ra-imp-rows')).toContainText('do not add up to 100, 1,000 or another power of ten');
  await expect(card.locator('.ra-imp-preview')).not.toContainText('CH-RM-1');
  await expect(card.locator('.ra-imp-preview')).not.toContainText('99.96');
  await expect(card.locator('[data-act="commit"]')).toBeDisabled();
  const [fix] = await Promise.all([page.waitForEvent('download'), card.locator('[data-act="problems-csv"]').click()]);
  expect(fix.suggestedFilename()).toBe('formulas-rows-to-fix.csv');

  await card.locator('[data-act="file"]').setInputFiles(file('recipe.csv', [`${code},1,1,CH-RM-1,1000`]));
  await expect(card.locator('.ra-imp-counts')).toContainText('1 to import');
  await expect(card.locator('.ra-imp-rows')).toContainText('Sealed under your name and sent for review');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `e2e/.run/shots/vault-imports-${info.project.name}.png`, fullPage: false });
  await card.locator('[data-act="commit"]').click();
  await expect.poll(() => sql(`select v.status || ' ' || (select count(*) from formula.formula_ingredients i where i.formula_version_id=v.formula_version_id)
    from formula.formula_version v join formula.formula_master m on m.formula_id=v.formula_id where m.formula_code='${code}'`, 'vault'), { timeout: 20_000 }).toMatch(/^(REVIEW|VERSIONED) 1$/);
  // What the import kept: no cell, and not the ingredient's code.
  expect(sql(`select count(*) from formula.import_job_row where cells is not null`, 'vault')).toBe('0');
  expect(sql(`select count(*) from (select row_to_json(x)::text j from formula.import_job_row x) y where j like '%CH-RM-1%'`, 'vault')).toBe('0');
  // STAGE-2-RP: this counted every stored answer that names CH-RM-1, and in a whole run the compliance walk's
  // allergen upload (another route, about a material's own composition, before this walk) had left two. The
  // claim here is the recipe import's: no stored answer names this formula, and none but an allergen answer
  // names the ingredient.
  expect(sql(`select count(*) from (select row_to_json(x)::text j from formula.idempotency_key x) y where j like '%${code}%' and j like '%CH-RM-1%'`, 'vault')).toBe('0');
  expect(sql(`select count(*) from (select row_to_json(x)::text j from formula.idempotency_key x) y where j like '%CH-RM-1%' and j not like '%"kind": "allergen"%'`, 'vault')).toBe('0');
  expect(errors).toEqual([]);
});

test('an approver does not see the upload at all', async ({ page }) => {
  await signIn(page, 'vault', 'vault_approver');
  await vaultGo(page, '#/recipes', 'Recipes needed');
  await expect(page.locator('.card-hd h2', { hasText: 'Recipes needed' })).toBeVisible(); // the screen has drawn
  await page.waitForTimeout(1200); // and a late panel has had its chance
  await expect(page.locator('.ra-imp-card')).toHaveCount(0);
});
