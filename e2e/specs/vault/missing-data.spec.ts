/* Vault: missing data. The chain material is used in a formula and has no IFRA row. */
import { expect, test } from '@playwright/test';
import { formula, must, rp } from '../../harness/chain';
import { signIn, vaultGo } from '../../harness/walk';

test('a material without compliance data is reported as missing, never as clear; filling is refused', async ({ page }) => {
  await formula();
  // Test values in the test database: without an amendment everything reads NOT_CONFIGURED, which is the fail-closed answer.
  await must('vault_approver', 'PUT', '/v1/compliance/settings', { ifraAmendment: 'BROWSER-SUITE-TEST', reportingThresholdPct: 0.001, allergenListRef: 'browser suite test list' }, { vault: true });
  await must('vault_approver', 'POST', '/v1/compliance/recalculate', {}, { vault: true });
  await signIn(page, 'vault', 'vault_approver');
  await vaultGo(page, '#/missing', 'Missing data');
  await expect(page.locator('tbody')).toContainText('CH-RM-1');
  await expect(page.locator('tbody')).toContainText('IFRA');
  expect((await rp('filling', 'GET', '/v1/compliance/missing', undefined, { vault: true })).status).toBe(403);
});
