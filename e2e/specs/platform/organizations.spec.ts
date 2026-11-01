/* Platform: organizations. F6: Factory's Organizations form writes iam.organizations, Platform lists iam.org_master,
 * so a company added on that form never shows here. Walked with both halves stated: the row Platform can show comes
 * from POST /v1/orgs, which has no screen. */
import { expect, test } from '@playwright/test';
import { must, rp } from '../../harness/chain';
import { platformGo, signIn, sql, uniq } from '../../harness/walk';

test('an org_master row reads back on Platform; filling is refused the list and the create', async ({ page }, info) => {
  const code = uniq('ORG', info);
  await must('owner', 'POST', '/v1/orgs', { organizationCode: code, organizationName: `Walk ${code}` });
  expect(sql(`select count(*) from iam.org_master where organization_code='${code}'`)).toBe('1');
  await signIn(page, 'platform', 'platform_super_admin');
  await platformGo(page, '#/organizations', 'Organizations');
  await expect(page.locator('tbody')).toContainText(code);
  expect((await rp('filling', 'GET', '/v1/platform/tenants')).status).toBe(403);
  expect((await rp('filling', 'POST', '/v1/orgs', { organizationCode: 'NO', organizationName: 'No' })).status).toBe(403);
});
