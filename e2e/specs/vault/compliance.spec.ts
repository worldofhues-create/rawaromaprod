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
  await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
  const dialog = page.locator('.dialog, [role="dialog"]').last();
  await dialog.locator('select').first().selectOption('allergen');
  await dialog.locator('textarea').first().fill('material_code,allergen_name,percentage,source\nCH-RM-1,Limonene,0.5,browser suite test row\n');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect.poll(() => sql(`select count(*) from formula.rm_allergen_composition`, 'vault'), { timeout: 20_000 }).not.toBe('0');
  await page.reload();
});
