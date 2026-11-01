/* Platform: organizations. Created in Factory's Admin workspace, read on Platform. */
import { expect, test } from '@playwright/test';
import { rp } from '../../harness/chain';
import { platformGo, createViaForm, openNav, signIn, sql, uniq } from '../../harness/walk';

test('an organization added by the admin appears on Platform; filling is refused', async ({ page }, info) => {
  const name = uniq('Org', info);
  await signIn(page, 'factory', 'admin');
  await openNav(page, 'Organizations');
  await createViaForm(page, { type: 'COMPANY', name });
  expect(sql(`select count(*) from iam.organizations where name='${name}'`)).toBe('1');
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/organizations', 'Organizations');
  await expect(page.locator('tbody')).toContainText(name);
  expect((await rp('filling', 'GET', '/v1/platform/tenants')).status).toBe(403);
});
