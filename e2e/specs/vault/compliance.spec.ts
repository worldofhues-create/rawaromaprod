/* Vault: compliance data and calculate; certificates and result to sales; missing data.
 * Three flows of one chain, split by file below so each is reported by name. This file: data + calculate.
 * The IFRA values are test rows with a `source` naming this suite. No real restriction is asserted. */
import { expect, test } from '@playwright/test';
import { formula, master, rp } from '../../harness/chain';
import { vaultGo, signIn, sql } from '../../harness/walk';

test('compliance data imported by CSV reads back and Recalculate writes a status; a formulator cannot write it', async ({ page }) => {
  await master(); await formula();
  expect((await rp('filling', 'GET', '/v1/compliance/materials', undefined, { vault: true })).status).toBe(403);
  await signIn(page, 'vault', 'vault_approver');
  await vaultGo(page, '#/compliance', 'Compliance data');
  const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Import CSV' }) });
  await card.locator('select').first().selectOption('allergen_ref');
  await card.locator('textarea').fill('cas,name,sort_order\n1111-11-1,Browser suite test allergen,1\n');
  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  await card.getByRole('button', { name: 'Import', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from formula.compliance_allergen_ref where name='Browser suite test allergen'`, 'vault'), { timeout: 20_000 }).toBe('1');
  await card.locator('select').first().selectOption('allergen');
  await card.locator('textarea').fill('material_code,cas,natural_pct,synthetic_pct\nCH-RM-1,1111-11-1,0.5,0\n');
  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  await card.getByRole('button', { name: 'Import', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from formula.rm_allergen_composition`, 'vault'), { timeout: 20_000 }).not.toBe('0');
  await page.getByRole('button', { name: 'Recalculate all', exact: true }).click();
  await expect.poll(() => sql('select count(*) from formula.compliance_calc_status', 'vault'), { timeout: 20_000 }).not.toBe('0');
});
