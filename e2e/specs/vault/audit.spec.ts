/* Vault: access audit and production audit. */
import { expect, test } from '@playwright/test';
import { formula, rp } from '../../harness/chain';
import { vaultGo, signIn, sql } from '../../harness/walk';

test('an approver reads the audit trail of a real formula change; filling is refused', async ({ page }) => {
  await formula();
  expect(Number(sql('select count(*) from formula.formula_event_hist', 'vault'))).toBeGreaterThan(0);
  await signIn(page, 'vault', 'vault_approver');
  await vaultGo(page, '#/audit-access', 'Access audit');
  await page.evaluate(() => { location.hash = '#/audit-mfg'; });
  await expect(page.locator('#vault-title')).toHaveText('Production audit');
  expect((await rp('filling', 'GET', '/v1/audit-events', undefined, { vault: true })).status).toBe(403);
});
