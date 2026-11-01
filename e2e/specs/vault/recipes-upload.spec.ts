/* Vault: formula needed, recipes needed, upload. */
import { expect, test } from '@playwright/test';
import { master, requirement, rp } from '../../harness/chain';
import { vaultGo, signIn, sql, uniq } from '../../harness/walk';

test('a product shell gets its recipe by CSV: checked, sealed, and read back; filling is refused', async ({ page }, info) => {
  await master();
  await requirement(uniq('RAC-', info));
  const code = uniq('F-CSV-', info);
  const shell = await rp('formulator', 'POST', '/v1/formulas', { formulaCode: code, formulaName: `Csv ${code}` }, { vault: true });
  expect(shell.status).toBe(201);
  await signIn(page, 'vault', 'formulator');
  await vaultGo(page, '#/recipes', 'Recipes needed');
  await page.locator('#recipe-upload').click();
  await page.getByPlaceholder(/product_code,material_code,percentage/).fill(`formula_code,material_code,percentage\n${code},CH-RM-1,100\n`);
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await page.locator('#recipe-seal').click();
  const formulaId = shell.body.formulaId;
  await expect.poll(() => sql(`select count(*) from formula.formula_ingredients i join formula.formula_version v using (formula_version_id) where v.formula_id='${formulaId}'`, 'vault'), { timeout: 20_000 }).toBe('1');
  await page.evaluate(() => { location.hash = '#/needed'; });
  await expect(page.locator('#vault-title')).toHaveText('Formula needed');
  expect((await rp('filling', 'POST', '/v1/formula-recipes/import', { csv: 'x', commit: false }, { vault: true })).status).toBe(403);
});
