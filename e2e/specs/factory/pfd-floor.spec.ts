/* PROD-D: Stock cover and QC review driven by hand, at 1440 and 375.
 *
 *   Stock cover  with no planning.cover rule the screen says first that every product is held; once a
 *                rule for the product is published, the suggestion shows what to make and why; the
 *                planner approves it, it is stored with its reasoning, a draft purchase request is
 *                raised for short raw stock, and the floor queue lists it below customer orders.
 *   QC review    a batch in review: downgrade and reblend are disabled with the reason; the perfumer
 *                proposes reject, the vault approver (another person) confirms, and the genealogy has it.
 *
 * ALEMBIC is not in this stack, so its orders are written straight into bridge.production_requirement,
 * where ImporterService would put them. Asserted on the screen and in the database. */
import { expect, test, type Page } from '@playwright/test';
import { must } from '../../harness/chain';
import { openNav, signIn, sql, uniq } from '../../harness/walk';

async function noSideScroll(page: Page) {
  const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(w).toBeLessThanOrEqual(1);
}
const q = (s: string) => s.replace(/'/g, "''");

async function product(code: string, name: string) {
  const productId = (await must('owner', 'POST', '/v1/products', { productCode: code, productName: name })).productId as string;
  const skuId = (await must('owner', 'POST', '/v1/product-skus', { skuCode: code + '-50', productId })).productSkuId as string;
  return { productId, skuId, sku: code + '-50' };
}

test('stock cover: held with no rule, then a reasoned suggestion a planner approves; it waits below customer orders', async ({ page }, info) => {
  const code = uniq('SC', info);
  const p = await product(code, 'Cover accord ' + code);
  // 26 weeks of ALEMBIC orders at ~38 a week, and one one-off bulk order
  for (let w = 0; w < 26; w++) {
    sql(`insert into bridge.production_requirement (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, lifecycle_status, created_dt)
         values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${code}-O${w}', '${p.sku}', 38, 'unit', now() + interval '7 days', 'ACCEPTED', now() - interval '${w * 7 + 1} days')`);
  }
  sql(`insert into bridge.production_requirement (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, needed_by, lifecycle_status, created_dt)
       values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${code}-BULK', '${p.sku}', 900, 'unit', now() + interval '7 days', 'ACCEPTED', now() - interval '2 days')`);
  // no rules at all: the policy as it ships
  await must('owner', 'POST', '/v1/policies/planning.cover/versions', { body: { rules: [], hasDefault: false }, reason: 'walk: as shipped, no rules' });

  await signIn(page, 'factory', 'production');
  await openNav(page, 'Stock cover');
  await expect(page.locator('#sc-policy')).toContainText('Every product is held: no stock-cover rules yet');
  const row = page.locator(`[data-sku="${p.sku}"]`);
  await expect(row).toContainText('Held');
  await expect(row.locator('[data-why]')).toContainText('planning.cover policy has no rule for this product');
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('cover-held.png'), fullPage: true });

  // an admin publishes a rule for this product (the Rules screen is lane A's walk)
  await must('owner', 'POST', '/v1/policies/planning.cover/versions', {
    body: { rules: [{ id: 'walk-' + code, scope: 'global', when: [{ field: 'sku', op: 'eq', value: p.sku }], then: { mode: 'dynamic', defaultLeadDays: 21 } }], hasDefault: false },
    reason: 'walk: one product dynamic' });
  await page.reload();
  await openNav(page, 'Stock cover');
  await expect(page.locator('#sc-policy')).toContainText('planning.cover v');
  await expect(row).toContainText('Suggested');
  await expect(row.locator('[data-why]')).toContainText(/Make \d+: sells ~38\/week/);
  await expect(row.locator('[data-why]')).toContainText(`left out as one-off: ${code}-BULK`);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('cover-suggested.png'), fullPage: true });

  await row.getByRole('button', { name: /^Approve \d+$/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(new RegExp(`Approved \\d+ of ${p.sku}`))).toBeVisible();
  expect(sql(`select status || ' ' || decided_by from production.cover_suggestion where sku_code = '${q(p.sku)}'`)).toMatch(/^APPROVED /);
  expect(sql(`select reasoning from production.cover_suggestion where sku_code = '${q(p.sku)}'`)).toMatch(/^Make \d+: sells ~38\/week/);
  await expect(page.locator(`[data-sku="${p.sku}"]`)).toContainText('approved and not started');

  await openNav(page, 'Floor queue');
  await expect(page.locator('#fl-planned')).toContainText(p.sku);
  await expect(page.locator('#fl-planned')).toContainText('below every customer order');
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('queue-planned.png'), fullPage: true });
});

test('QC review: downgrade and reblend disabled with the reason; the perfumer proposes reject, the vault approver confirms', async ({ page }, info) => {
  const code = uniq('RV', info);
  const p = await product(code, 'Review accord ' + code);
  // the product's formula (normally linked in Formula setup): its reblend rule is what review reads
  sql(`update packaging.product_master set formula_id = gen_random_uuid() where product_id = '${p.productId}'`);
  const set = sql(`insert into quality.qc_checkpoint_set (product_id, version, reason) values ('${p.productId}', 1, 'walk') returning qc_checkpoint_set_id`);
  const ob = sql(`insert into production.oil_batch_master (oil_batch_id, batch_number, produced_qty, status, created_by, updated_by) values (gen_random_uuid(), '${code}', 10, 'QC_PENDING', 'walk', 'walk') returning oil_batch_id`);
  for (const [n, d] of [[1, 'REWORK'], [2, 'REWORK'], [3, 'REVIEW']] as const) {
    sql(`insert into quality.batch_qc_round (oil_batch_id, round_no, qc_checkpoint_set_id, inspector_id, results, decision, reasons, rework_no, policy_version)
         values ('${ob}', ${n}, '${set}', 'walk-qc', '{}'::jsonb, '${d}', '["Strength low after rework ${n - 1}"]'::jsonb, ${n - 1}, 1)`);
  }
  sql(`insert into inventory.lot_hold (subject_type, subject_id, reason, source) values ('OIL_BATCH', '${ob}', 'QC REVIEW: failure after 2 reworks', 'QC_ROUND')`);

  await signIn(page, 'factory', 'formulator');
  await openNav(page, 'QC review');
  await page.locator(`[data-ob="${ob}"]`).click();
  const dg = page.locator('[data-opt="DOWNGRADE"]'), rb = page.locator('[data-opt="REBLEND"]');
  await expect(dg.getByRole('button', { name: 'Downgrade (not available)' })).toBeDisabled();
  await expect(dg).toContainText(`No downgrade target is defined for Review accord ${code}`);
  await expect(rb.getByRole('button', { name: 'Reblend (not available)' })).toBeDisabled();
  await expect(rb).toContainText('This formula does not allow reblending');
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('review-options.png'), fullPage: true });
  await page.locator('[data-opt="REJECT"]').getByRole('button', { name: 'Reject' }).click();
  await page.locator('[data-ask="reason"]').fill('Wrong odour profile after two reworks');
  await page.getByRole('button', { name: 'Propose reject' }).click();
  await expect(page.locator('#qr-one').getByText('Reject proposed', { exact: true })).toBeVisible();
  await expect(page.getByText('You proposed this: a different person with the other signature confirms it.')).toBeVisible();

  await signIn(page, 'factory', 'vault_approver');
  await openNav(page, 'QC review');
  await page.locator(`[data-ob="${ob}"]`).click();
  await page.getByRole('button', { name: 'Confirm as vault approver' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('#qr-one').getByText('Decided: Reject', { exact: true })).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath('review-decided.png'), fullPage: true });
  expect(sql(`select relationship_type from inventory.batch_genealogy_history where oil_batch_id = '${ob}'`)).toBe('QC_REVIEW_REJECT');
  expect(sql(`select proposed_as || ' ' || confirmed_as || ' ' || status from quality.batch_review_decision where oil_batch_id = '${ob}'`)).toBe('PERFUMER APPROVER CONFIRMED');
  expect(sql(`select c.status from quality.qc_capa c join quality.batch_review_decision d on d.qc_capa_id = c.qc_capa_id where d.oil_batch_id = '${ob}'`)).toBe('OPEN');
});
