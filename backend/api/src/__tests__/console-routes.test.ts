/**
 * Readable addresses for the Factory, Platform and Vault consoles (lane ux-audit, owner 2026-10-09:
 * "audit all consoles and its url path fixes so that it becomes easy to use … no training required").
 *
 * Static, like console-dock.test.ts: web/routes.js and web/screen-guide.js (pure models) and the
 * Factory's shell.js + ws-*.js run in a `vm` context with a small fake window/document, so ROLES,
 * the route table and the redirects are checked exactly as the page builds them. Platform and Vault
 * routes are read from their sources. The consoles were also driven headless at 1440 and 390 px
 * (docs/ui/evidence/ux-audit/).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const J = (v: unknown) => JSON.parse(JSON.stringify(v));

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The Factory console as the browser loads it (index.html order), minus boot (readyState 'loading'). */
function factory(): any {
  const noop = () => {};
  const el = (): any => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, setAttribute: noop, appendChild: noop, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] });
  const store = new Map<string, string>();
  const ctx: any = {
    console, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    document: { readyState: 'loading', addEventListener: noop, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: el, head: el(), body: el(), documentElement: el() },
    navigator: { onLine: true }, location: { hash: '', pathname: '/', search: '', href: 'https://rawfactory.example/' }, history: { replaceState: noop, pushState: noop },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    addEventListener: noop, innerWidth: 1800, innerHeight: 1000,
    matchMedia: () => ({ matches: false, addEventListener: noop }), TextEncoder, TextDecoder, atob, btoa, URL,
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  const html = read('web/index.html');
  const want = ['dock.js', 'ruh.js', 'routes.js', 'screen-guide.js', 'shell.js', 'ws-supply.js', 'ws-mfg.js', 'ws-platform.js', 'ws-produce.js', 'ws-setup.js', 'ws-formula-setup.js'];
  const scripts = [...html.matchAll(/<script src="\/([\w-]+\.js)"/g)].map((m) => m[1] ?? '').filter((f) => want.includes(f));
  assert.deepEqual(scripts, want, 'routes.js and screen-guide.js load after ruh.js and before shell.js');
  for (const f of scripts) vm.runInContext(read(`web/${f}`), ctx, { filename: f });
  vm.runInContext('applyGuideLabels()', ctx);
  return ctx;
}
const run = (ctx: any, code: string) => vm.runInContext(code, ctx);
const UUID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

test('routes.js and screen-guide.js are cached offline with the bumped Factory shell', () => {
  const sw = read('web/sw.js');
  assert.match(sw, /const CACHE = 'ra-shell-v98'/);
  assert.match(sw, /'\/routes\.js', '\/screen-guide\.js', '\/shell\.js'/);
});

test('every Factory screen has one readable address per workspace, and it reads back to the same screen', () => {
  const ctx = factory();
  const roles = J(run(ctx, 'ROLES'));
  const R = ctx.RaRoutes;
  for (const role of Object.keys(roles)) {
    const ws = R.WORKSPACE[role];
    assert.match(ws, /^[a-z]+$/, `${role}: a one-word workspace`);
    const seen = new Set<string>();
    for (const nav of roles[role].nav) {
      const slug = R.slugOf(nav[3]);
      assert.match(slug, /^[a-z]+(-[a-z]+)*$/, `${role}/${nav[0]}: "${slug}" is lowercase words joined by hyphens`);
      assert.ok(!seen.has(slug), `${role}: two screens share the address ${slug}`);
      seen.add(slug);
      const hash = R.build(role, nav, '');
      assert.equal(hash, `#/${ws}/${slug}`);
      const back = J(R.resolve(R.parse(hash), roles, [role], role));
      assert.deepEqual([back.role, back.key, back.canonical, back.moved], [role, nav[0], hash, false]);
      const rec = R.build(role, nav, 'PO-2026/07');
      assert.equal(rec, `#/${ws}/${slug}/PO-2026%2F07`, 'a record code is one encoded segment');
      assert.equal(R.resolve(R.parse(rec), roles, [role], role).ref, 'PO-2026/07');
    }
  }
});

test('the route table (what the address bar says for the main screens)', () => {
  const ctx = factory();
  const map = (role: string, key: string) => run(ctx, `(function(){ st.role = ${JSON.stringify(role)}; return routeFor(${JSON.stringify(key)}); })()`);
  const table: Array<[string, string, string]> = [
    ['superadmin', 'dashboard', '#/owner/home'], ['superadmin', 'produce', '#/owner/produce-next'], ['superadmin', 'runs', '#/owner/production-orders'],
    ['production', 'runs', '#/production/production-orders'], ['production', 'bridgereq', '#/production/alembic-orders'], ['production', 'coa', '#/production/batch-certificates'],
    ['qc', 'queue', '#/qc/test-queue'], ['qc', 'coaspec', '#/qc/product-test-specs'], ['warehouse', 'dashboard', '#/warehouse/home'],
    ['warehouse', 'stock', '#/warehouse/stock'], ['warehouse', 'shelftasks', '#/warehouse/put-away-and-pick'], ['procurement', 'rfq', '#/procurement/quote-requests'],
    ['procurement', 'pos', '#/procurement/purchase-orders'], ['receiving', 'grns', '#/receiving/goods-receipts'], ['receiving', 'batches', '#/receiving/raw-material-batches'],
    ['packaging', 'orders', '#/packaging/packing-orders'], ['filling', 'orders', '#/filling/packing-orders'], ['sales', 'orders', '#/sales/sales-orders'],
    ['compounding', 'orders', '#/compounding/production-orders'], ['admin', 'loginhist', '#/admin/sign-in-history'], ['superadmin', 'formulasetup', '#/owner/formula-setup'],
  ];
  for (const [role, key, hash] of table) assert.equal(map(role, key), hash, `${role}/${key}`);
});

test('older links keep working: every #/go/… link Ruh writes opens a screen and is rewritten to the readable address', () => {
  const ctx = factory();
  const roles = J(run(ctx, 'ROLES'));
  const R = ctx.RaRoutes;
  const src = read('backend/api/src/ruh/ruh-detectors.ts') + read('backend/api/src/ruh/ruh-guards.service.ts');
  const links = [...new Set([...src.matchAll(/`?'?(#\/go\/[a-z|]+)/g)].map((m) => m[1] ?? ''))];
  assert.ok(links.length >= 10, `found ${links.length} Ruh links`);
  const all = Object.keys(roles);
  for (const link of links) {
    const withRecord = `${link}/${UUID}`;
    const hit = all.map((r) => R.resolve(R.parse(withRecord), roles, [r], r)).find(Boolean);
    assert.ok(hit, `${link}: some workspace opens it`);
    assert.match(hit.canonical, new RegExp(`^#/[a-z]+/[a-z-]+/${UUID}$`), `${link} → ${hit.canonical}`);
  }
  const cases: Array<[string, string[], string]> = [
    [`#/go/produce/${UUID}`, ['production'], `#/production/produce-next/${UUID}`],
    [`#/go/skus|produce/${UUID}`, ['packaging'], `#/packaging/pack-sizes/${UUID}`],
    [`#/go/skus|produce/${UUID}`, ['production'], `#/production/produce-next/${UUID}`],
    ['#/go/coa', ['qc'], '#/qc/batch-certificates'],
    ['#/go/queue|rm', ['warehouse'], '#/warehouse/raw-material-batches'],
    ['#/go/reorder|stock|materials', ['admin'], '#/admin/materials'],
    ['#/go/factorysetup', ['superadmin'], '#/owner/factory-setup'],
    ['#/coa', ['qc'], '#/qc/batch-certificates'],
  ];
  for (const [link, held, want] of cases) assert.equal(R.resolve(R.parse(link), roles, held, held[0])?.canonical, want, link);
});

test('a link names a workspace: it opens there if you hold it, in another of yours that has the screen if not, and never otherwise', () => {
  const ctx = factory();
  const roles = J(run(ctx, 'ROLES'));
  const R = ctx.RaRoutes;
  const coa = R.parse('#/qc/batch-certificates/FG-0012');
  assert.deepEqual(J(R.resolve(coa, roles, ['production', 'qc'], 'production')), { role: 'qc', key: 'coa', ref: 'FG-0012', canonical: '#/qc/batch-certificates/FG-0012', moved: false });
  assert.deepEqual(J(R.resolve(coa, roles, ['production'], 'production')), { role: 'production', key: 'coa', ref: 'FG-0012', canonical: '#/production/batch-certificates/FG-0012', moved: true });
  assert.equal(R.resolve(R.parse('#/procurement/purchase-orders'), roles, ['qc'], 'qc'), null, 'QC holds no purchase orders screen');
  assert.equal(R.resolve(R.parse('#/owner/production-orders'), roles, ['superadmin'], 'superadmin').key, 'runs');
  assert.equal(R.resolve(R.parse('#/superadmin/production-orders'), roles, ['superadmin'], 'superadmin').canonical, '#/owner/production-orders', 'a role key typed by hand is rewritten to the workspace word');
  assert.equal(R.resolve(R.parse('#/qc/no-such-screen'), roles, ['qc'], 'qc'), null);
});

test('addresses that are not screens are left to their owners', () => {
  const R = factory().RaRoutes;
  assert.equal(R.parse('').kind, 'none');
  assert.equal(R.parse('#').kind, 'none');
  assert.equal(R.parse('#/').kind, 'none');
  assert.equal(R.parse('#assertion=abc.def.ghi').kind, 'assertion', 'the ALEMBIC sign-in hand-off');
  assert.equal(R.parse('#shelf=Z1').kind, 'none', 'the shelf TV hand-off (ws-produce.js reads it)');
});

test('a record is addressed by its own code (batch, PO, SKU …), falling back to its id', () => {
  const R = factory().RaRoutes;
  assert.equal(R.refOf({ purchaseOrderId: UUID, poNumber: 'PO-0007', vendorCode: 'V-01' }), 'PO-0007');
  assert.equal(R.refOf({ rmBatchId: UUID, batchNumber: 'RM-26-0001', materialCode: 'M-1' }), 'RM-26-0001');
  assert.equal(R.refOf({ productionOrderId: UUID, orderQty: 10 }), UUID, 'no code: the id');
  assert.equal(R.refOf({ batchNumber: UUID, rmBatchId: UUID }), UUID, 'an id in a code column is not a code');
  assert.ok(R.rowMatches({ poNumber: 'PO-0007', purchaseOrderId: UUID }, 'po-0007'), 'codes match regardless of case');
  assert.ok(R.rowMatches({ poNumber: 'PO-0007', purchaseOrderId: UUID }, UUID), 'an older link with the id still finds the row');
  assert.ok(!R.rowMatches({ poNumber: 'PO-0007' }, 'PO-0008'));
});

test('one plain name per screen: no jargon labels, the same data has the same name everywhere, and no two screens in a workspace share a name', () => {
  const ctx = factory();
  const roles = J(run(ctx, 'ROLES'));
  const jargon = ['Master runs', 'RM aliases', 'Split containers', 'Geo levels', 'FG stock (ATP)', 'Qty verification', 'Bulk lots', 'Pack orders',
    'Package orders', 'Write audit trail', 'ALEMBIC requirements', 'Batch COA', 'QC specs (COA)', 'Stock (FEFO)', 'RFQs', 'RM batches', 'Settlements',
    'Rejected GRNs', 'Vendor dispatch', 'CAPA', 'Plan items', 'Pick list items', 'Product SKUs', 'Packaging BOM', 'FG labels', 'FG reservations'];
  const byEndpoint = new Map<string, Set<string>>();
  for (const [role, r] of Object.entries<any>(roles)) {
    const labels = r.nav.map((n: string[]) => n[1]);
    assert.equal(new Set(labels).size, labels.length, `${role}: duplicate screen names`);
    for (const n of r.nav) {
      assert.ok(!jargon.includes(n[1]), `${role}/${n[0]} still says "${n[1]}"`);
      if (!ctx.RaGuide.ROLE_LABEL[role]?.[n[3]] && n[3] !== '__dash__') (byEndpoint.get(n[3]) ?? byEndpoint.set(n[3], new Set()).get(n[3])!).add(n[1]);
    }
  }
  for (const [ep, names] of byEndpoint) assert.equal(names.size, 1, `${ep} is called ${[...names].join(' / ')}`);
});

test('every Factory screen says what it is for, and long workspaces read as named groups', () => {
  const ctx = factory();
  const roles = J(run(ctx, 'ROLES'));
  const G = ctx.RaGuide;
  for (const [role, r] of Object.entries<any>(roles)) {
    for (const n of r.nav) {
      const help = G.help(n[3]);
      assert.ok(help.length >= 20, `${role}/${n[0]} has no help line`);
      assert.ok(G.GROUPS.includes(G.group(n[3])), `${role}/${n[0]} has a group`);
    }
  }
  const rail = run(ctx, `(function(){ st.role = 'superadmin'; st.nav = 'dashboard'; return railNavHtml(ROLES.superadmin); })()`);
  for (const g of ['PRODUCTION', 'QUALITY', 'SETUP', 'HELP']) assert.ok(rail.includes(`<div class="rs rs-group" role="presentation">${g}</div>`), `owner rail shows ${g}`);
  const short = run(ctx, `(function(){ st.role = 'filling'; st.nav = 'dashboard'; return railNavHtml(ROLES.filling); })()`);
  assert.ok(!short.includes('rs-group'), 'a short list stays one list');
});

test('status chips and column headings use words, never codes', () => {
  const ctx = factory();
  const cell = (k: string, v: unknown) => run(ctx, `fmt(${JSON.stringify(k)}, ${JSON.stringify(v)}, {})`);
  assert.match(cell('status', 'INPROGRESS'), />In progress</);
  assert.match(cell('status', 'PENDING_APPROVAL'), />Waiting for approval</);
  assert.match(cell('status', 'MATERIALS_ISSUED'), />Materials issued</);
  assert.match(cell('overallResult', 'REJECT'), />Rejected</);
  assert.match(cell('status', 'SOMETHING_NEW'), />Something new</, 'an unknown code still reads as words');
  assert.match(cell('result', 'Refused: no account'), /color:var\(--red\)/, 'login-history refusals keep their own style');
  const lab = (k: string) => run(ctx, `label(${JSON.stringify(k)})`);
  assert.equal(lab('fefoFlag'), 'Use first');
  assert.equal(lab('formulaVersionId'), 'Formula version');
  assert.equal(lab('flashPointMinC'), 'Flash point min (°C)');
  assert.equal(lab('reraNo'), 'Registration no.');
  assert.equal(lab('someNewField'), 'Some New Field');
});

test('Platform: readable addresses, older ones rewritten, gated screens hidden from roles without them', () => {
  const js = read('web-platform/platform.js');
  const route = /var ROUTE = (\{[^}]+\});/.exec(js);
  assert.ok(route);
  const ROUTE = vm.runInNewContext(`(${route[1]})`);
  for (const [id, word] of Object.entries<string>(ROUTE)) assert.match(word, /^[a-z]+(-[a-z]+)*$/, `${id} → ${word}`);
  assert.equal(ROUTE.support, 'sign-in-history');
  assert.equal(ROUTE.picklight, 'pick-to-light');
  assert.match(js, /function idOfRoute\(word\) \{ for \(var k in ROUTE\) \{ if \(ROUTE\[k\] === word\) return k; \} return ROUTE\[word\] \? word : null; \}/, 'an older #/support or #/picklight still resolves');
  assert.match(js, /history\.replaceState\(null, '', location\.pathname \+ location\.search \+ want\)/, 'and is rewritten without a history entry');
  for (const id of ['tenants', 'providers', 'deploy']) assert.match(js, new RegExp(`\\{ id: '${id}', label: '[^']+', icon: '[a-z]+', need: 'platformops:console:read' \\}`), `${id} is gated like its screen`);
  assert.match(js, /var m = \/\^#\\\/\(\[a-z-\]\+\)\/\.exec\(String\(i\.deepLink \|\| ''\)\), id = m && idOfRoute\(m\[1\]\);/, 'Ruh notes use the same resolver');
  assert.match(js, /localStorage\.setItem\(AFTER_SIGNIN/, 'the asked-for screen survives sign-in');
});

test('Vault: record addresses keep opaque ids (never a formula name), trail on record screens, no browser storage', () => {
  const js = read('web-vault/vault.js');
  assert.match(js, /location\.hash = '#\/formula\/' \+ f\.formulaId/);
  assert.ok(!/#\/formula\/' \+ f\.formulaCode/.test(js), 'no formula code in the address bar or the browser history');
  assert.match(js, /setPlace\(\[\{ label: 'Formulas', hash: '#\/formulas' \}, \{ label: \(parent && parent\.formulaCode\) \|\| 'Formula', hash: '#\/formula\/' \+ version\.formulaId \}, \{ label: 'Version ' \+ version\.versionNumber \}\]\);/);
  assert.match(js, /if \(\(m\[1\] === 'formula' \|\| m\[1\] === 'version'\) && m\[2\]\) \{ location\.hash = link; return true; \}/, 'Ruh notes can open a record');
  assert.doesNotMatch(js, /localStorage\.setItem|sessionStorage\.setItem/);
  assert.match(js, /var DOCK_ORDER = \['formulas', 'needed', 'recipes', 'review'/, 'an approver\'s main task is on the phone tab bar');
});
