/* Platform: organizations. Added on Factory's Admin form, read on Platform: both now use iam.org_master. */
import { expect, test } from '@playwright/test';
import { rp } from '../../harness/chain';
import { createViaForm, expectRefused, openNav, platformGo, signIn, sql, uniq } from '../../harness/walk';

test('an organization added on the Factory form shows on Platform; filling is refused both', async ({ page }, info) => {
  const code = uniq('ORG', info);
  await signIn(page, 'factory', 'admin');
  await openNav(page, 'Organizations');
  await createViaForm(page, { organizationCode: code, organizationName: `Walk ${code}` });
  expect(sql(`select count(*) from iam.org_master where organization_code='${code}'`)).toBe('1');
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/organizations', 'Organizations');
  await expect(page.locator('tbody')).toContainText(code);
  expect((await rp('filling', 'GET', '/v1/platform/tenants')).status).toBe(403);
  await signIn(page, 'factory', 'filling');
  await expect(page.locator('#ra-side .who small')).toHaveText('Filling');
  await expectRefused(page, 'POST', '/v1/orgs', { organizationCode: 'NO', organizationName: 'No' });
});
