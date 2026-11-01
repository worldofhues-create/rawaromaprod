/* What every walk needs: a signed hand-over, the database read directly, and the refusal check.
 *
 * SIGN-IN. Password sign-in is retired; the only door is an assertion from ALEMBIC. This suite holds
 * the private half of a per-run key and signs one exactly as ALEMBIC's rawprod-assertion.ts does, so
 * RawProd's whole verification runs for real. ALEMBIC itself is NOT in this stack: that its staff strip
 * mints the token is covered on the Alembic side and by the golden story, not here. */
import { expect, type Page, type TestInfo } from '@playwright/test';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DB_HOST, DB_USER, DB_PASS, MAIN_DB, PORTS, RUN, URLS, VAULT_DB } from './config.mjs';

export type ConsoleName = 'factory' | 'platform' | 'vault';
export const EMAIL: Record<string, string> = {
  owner: 'owner@rawaroma.local', admin: 'admin@rawaroma.local', procurement: 'procurement@rawaroma.local',
  receiving: 'receiving@rawaroma.local', qc: 'qc@rawaroma.local', warehouse: 'warehouse@rawaroma.local',
  compounding: 'compounding@rawaroma.local', production: 'production@rawaroma.local', filling: 'filling@rawaroma.local',
  packaging: 'packaging@rawaroma.local', sales: 'sales@rawaroma.local', formulator: 'formulator@rawaroma.local',
  vault_approver: 'vault.approver@rawaroma.local', platform_super_admin: 'platform.admin@rawaroma.local',
};

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');
/** Stable per person: the first assertion binds `sub` to the row, and a different one is refused. */
function subjectOf(email: string) {
  const h = createHash('sha256').update(email).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function mintAssertion(email: string, target: ConsoleName, over: Record<string, unknown> = {}) {
  const { signingKey } = JSON.parse(readFileSync(join(RUN, 'keys.json'), 'utf8'));
  const key = createPrivateKey({ key: Buffer.from(signingKey, 'base64'), format: 'der', type: 'pkcs8' });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'alembic', aud: 'rawprod', sub: subjectOf(email), tenant_id: 'rac', org_id: 'rac', email, roles: ['admin'],
    target, auth_time: now, iat: now, exp: now + 45, jti: randomUUID(), env: 'production', ...over };
  const signingInput = `${b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}`;
  return `${signingInput}.${b64u(sign(null, Buffer.from(signingInput), key))}`;
}

/** Open a console signed in as a seeded role: the real `#assertion=` hand-over. */
export async function signIn(page: Page, consoleName: ConsoleName, role: string) {
  // The "install this app" tip covers the dock until dismissed; a person dismisses it once.
  await page.addInitScript(() => { try { localStorage.setItem('rac.console.install.dismissed.v1', String(Date.now())); } catch { /* */ } });
  // The first-visit tour offer can appear at any moment after load; a person says not now.
  await page.addLocatorHandler(page.getByRole('button', { name: 'Maybe later', exact: true }), async (b) => { await b.click(); }).catch(() => {});
  await page.goto('about:blank'); // a second sign-in in one walk: a hash-only change would not load the page
  await page.goto(`${URLS[consoleName]}/#assertion=${encodeURIComponent(mintAssertion(EMAIL[role]!, consoleName))}`);
}

/** Read the real database. Assert on this as well as the screen, so a stale page cannot pass. */
export function sql(query: string, db: 'main' | 'vault' = 'main'): string {
  const name = db === 'main' ? MAIN_DB : VAULT_DB;
  return execFileSync(process.env.BS_PG_EXTERNAL === '1' ? 'psql' : join(process.env.BS_PG_BIN || '/opt/homebrew/opt/postgresql@17/bin', 'psql'),
    ['-h', DB_HOST, '-p', String(PORTS.pg), '-U', DB_USER, '-d', name, '-qAt', '-c', query],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: DB_PASS } }).trim();
}

/** A code no earlier walk used: the suite shares one database across widths and runs. */
export function uniq(prefix: string, info: TestInfo) {
  return `${prefix}${info.project.name.endsWith('375') ? 'M' : 'D'}${Date.now().toString(36).toUpperCase()}`;
}

/** Factory console, through its own encrypted tunnel: what the page's own call would get. */
export async function factoryCall(page: Page, method: string, path: string, body?: unknown) {
  await page.waitForFunction(() => typeof (window as any).tunnel === 'function');
  return page.evaluate(async ([m, p, b]) => {
    const r = await (window as any).tunnel(p, b === undefined ? { method: m } : { method: m, body: b });
    return { status: r.status as number, json: r.json as any };
  }, [method, path, body] as const);
}

/** The walk's role refusal: the server, not just a hidden button, says no. */
export async function expectRefused(page: Page, method: string, path: string, body?: unknown) {
  const r = await factoryCall(page, method, path, body);
  expect(r.status, `${method} ${path} must be refused`).toBe(403);
}

/** Open a Factory screen from the rail, as a person does: the rail is folded behind the dock's
 *  All sections button (More, on a phone) at both widths. */
export async function openNav(page: Page, label: string) {
  const entry = page.locator('#ra-railnav button.ri').filter({ has: page.getByText(label, { exact: true }) }).first();
  await expect(page.locator('#ra-dock-toggle')).toBeVisible();
  if ((await page.locator('#ra-dock-toggle').getAttribute('aria-pressed')) !== 'true') await page.locator('#ra-dock-toggle').click();
  await entry.click();
  await expect(page.locator('#ra-title')).toHaveText(label);
}

export type Field = string | number | { label: string } | { first: true };

/** Fill the console's generic form (data-name fields), as typed or chosen by a person. */
export async function fillForm(page: Page, values: Record<string, Field>) {
  for (const [name, v] of Object.entries(values)) {
    const el = page.locator(`#ra-cform [data-name="${name}"], .sheet [data-name="${name}"], [role="dialog"] [data-name="${name}"]`).first();
    const tag = await el.evaluate((n) => n.tagName);
    if (tag !== 'SELECT') { await el.fill(String(v)); continue; }
    await expect(el.locator('option:not([value=""])').first()).toBeAttached();
    if (typeof v === 'object' && 'first' in v) await el.selectOption({ index: 1 });
    else if (typeof v === 'object') await el.selectOption({ label: v.label });
    else await el.selectOption(String(v));
  }
}

/** The screen's own "+ New …" form: fill, submit, and fail on any refusal the form shows. */
export async function createViaForm(page: Page, values: Record<string, Field>) {
  await page.locator('#ra-new').click();
  await fillForm(page, values);
  await page.locator('#ra-msave').click();
  await expect(page.locator('#ra-msave'), 'the form closes on success; a refusal stays on it').toHaveCount(0);
}

/** Read back: the row is on the screen, still there after a real reload, and in the database. */
export async function expectRowPersisted(page: Page, text: string, dbCheck: () => string, title?: string) {
  await expect(page.locator('#ra-results')).toContainText(text);
  await page.reload();
  if (title) await expect(page.locator('#ra-title')).toHaveText(title);
  await expect(page.locator('#ra-results')).toContainText(text);
  expect(dbCheck(), `row ${text} in the database`).not.toBe('0');
}

/** A role without the permission: no create button on the screen it can open, or the screen says so. */
export async function expectNoNewButton(page: Page) { await expect(page.locator('#ra-new')).toHaveCount(0); }

/** Press a button on the row carrying `rowText`. */
export async function rowAction(page: Page, rowText: string, label: string) {
  const row = page.locator('#ra-results tbody tr').filter({ hasText: rowText }).first();
  await expect(row, `row ${rowText}`).toBeVisible();
  await row.getByRole('button', { name: label, exact: true }).click();
}
/** Search the list so the row is on screen whichever page it falls on. */
export async function searchFor(page: Page, text: string) {
  await page.locator('#ra-search').fill(text);
  await expect(page.locator('#ra-results')).toContainText(text);
}

/** The document form (a header plus line items: PO, GRN, sales order). */
export async function createDoc(page: Page, header: Record<string, Field>, line: Record<string, Field>) {
  await page.locator('#ra-new').click();
  const fill = async (attr: string, values: Record<string, Field>) => {
    for (const [name, v] of Object.entries(values)) {
      const el = page.locator(`#ra-cform [data-${attr}="${name}"]`).first();
      if ((await el.evaluate((n) => n.tagName)) !== 'SELECT') { await el.fill(String(v)); continue; }
      if (typeof v === 'object' && 'first' in v) await el.selectOption({ index: 1 });
      else if (typeof v === 'object') await el.selectOption({ label: v.label });
      else await el.selectOption(String(v));
    }
  };
  await fill('h', header);
  await fill('i', line);
  await page.locator('#ra-msave').click();
  await expect(page.locator('#ra-msave'), 'the form closes on success; a refusal stays on it').toHaveCount(0);
}

/** raConfirm's dialog: its confirm button repeats the action's name. */
export async function confirmDialog(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).last().click();
}

/** The row whose record id this is (data-rid), for lists that show no code of their own. */
export function rowById(page: Page, id: string) { return page.locator(`#ra-results tr[data-rid="${id}"]`); }
