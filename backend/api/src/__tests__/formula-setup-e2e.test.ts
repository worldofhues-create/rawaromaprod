/**
 * Lane vaultsetup — the whole "every product gets a formula" path in the PRODUCTION SHAPE (the
 * vault-isolation-harness pattern): the real `main.ts` and the real `vault-main.ts` as two
 * processes, two databases that cannot see each other (each migrated like production, the main one
 * seeded with the real role catalogue by scripts/db-seed.ts), the main process's formula-DB URL
 * pointing at a listener that only counts connection attempts. Everything goes over HTTP.
 *
 *   1. Two owners grant Ruh `formulator` (POST /v1/service-principals/ruh/formulator-request, then
 *      the existing approve route): the requester's own approval is refused; a second owner's is not.
 *   2. Before any formula: "Produce next" is blocked with NO_FORMULA_LINK.
 *   3. Production drafts the shells (main -> Vault as Ruh): a single-chemical product and a blend,
 *      both linked. Now the block is NO_APPROVED_FORMULA (formula_needed).
 *   4. A formulator uploads the blend's recipe (CSV, parsed in the Vault, matched against the
 *      material catalogue the main box pushed); a preview with a typo shows it unmatched and seals
 *      nothing. A formulator cannot bulk-approve.
 *   5. ONE vault approver approves both versions in one request (one fresh sign-in); each approval
 *      is audited with that person; Ruh appears only as the author.
 *   6. Produce next now plans both runs: the masked pick list carries the right materials and
 *      quantities (single chemical: 100 % of its own material), the coded instruction shows floor
 *      codes; the requirement's block is cleared and formula-needs no longer lists the products.
 *   7. The main process never opened a formula-database connection.
 *
 * Needs the Docker/Homebrew PostGIS (TEST_DATABASE_URL on 127.0.0.1:5433), like the isolation harness.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { ConfigService, JwtService } from '@core/backend-kernel';
import { ROLES } from '../../../../scripts/ra-roles.js';
import { RA_PERMISSIONS } from '../../../../scripts/ra-permissions.js';
import { CAPABILITY_PERMISSIONS } from '../../../../scripts/ra-roles.js';

const REPO_ROOT = process.cwd();
const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_rp_policy_test';
const KEEP = process.env.KEEP_ISO_DBS === '1';
const KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const JWT_SECRET = `fs-harness-${'j'.repeat(32)}`;
const BRIDGE_KEY = `fs-harness-${'b'.repeat(32)}`;

const dbUrl = (name: string) => { const u = new URL(BASE_URL); u.pathname = `/${name}`; return u.toString(); };
const baseName = new URL(BASE_URL).pathname.replace(/^\//, '') || 'rawprod_test';
const MAIN_DB = `${baseName}_fs_main`.slice(0, 63);
const VAULT_DB = `${baseName}_fs_vault`.slice(0, 63);
const MAIN_URL = dbUrl(MAIN_DB);
const VAULT_URL = dbUrl(VAULT_DB);

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return addr.port;
}
function run(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.join(' ')} exited ${code}:\n${out.slice(-4000)}`))));
  });
}
interface Proc { child: ChildProcess; log: () => string }
function startNode(entry: string, env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ['--import', '@swc-node/register/esm-register', entry], {
    cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  return { child, log: () => out };
}
async function waitHealthy(url: string, proc: Proc, what: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) throw new Error(`${what} exited (${proc.child.exitCode}):\n${proc.log().slice(-4000)}`);
    try { if ((await fetch(`${url}/health`)).status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} never became healthy:\n${proc.log().slice(-4000)}`);
}
async function stop(proc: Proc | undefined): Promise<void> {
  if (!proc || proc.child.exitCode !== null) return;
  const exited = new Promise<void>((r) => proc.child.once('exit', () => r()));
  proc.child.kill('SIGTERM');
  const t = setTimeout(() => proc.child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(t);
}
async function eventually<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const v = await probe(); if (v !== undefined) return v; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what}: not within ${ms} ms${last ? ` (${(last as Error).message})` : ''}`);
}

let admin: Sql;
let mainSql: Sql;
let vaultSql: Sql;
let sentinel: NetServer;
let formulaDbConnects = 0;
let vaultProc: Proc | undefined;
let mainProc: Proc | undefined;
let mainApi = '';
let vaultApi = '';

const grant = (code: string) => [...RA_PERMISSIONS, ...CAPABILITY_PERMISSIONS].filter((p) => ROLES.find((r) => r.code === code)!.select(p));
const people = {
  ownerA: { id: randomUUID(), role: 'owner', token: '' },
  ownerB: { id: randomUUID(), role: 'owner', token: '' },
  production: { id: randomUUID(), role: 'production', token: '' },
  formulator: { id: randomUUID(), role: 'formulator', token: '' },
  approver: { id: randomUUID(), role: 'vault_approver', token: '' },
};
const tag = randomUUID().slice(0, 6).toUpperCase();
/** The single-chemical product's code IS its material's code (how the catalogue lines them up). */
const SINGLE = { productId: randomUUID(), code: `BENZYL-${tag}`, sku: `BENZYL-${tag}-25KG` };
const BLEND = { productId: randomUUID(), code: `OUD-${tag}`, sku: `OUD-${tag}-25KG` };
const MATS = {
  single: { id: randomUUID(), code: SINGLE.code, name: 'Benzyl acetate', alias: `FC-${tag}-1` },
  a: { id: randomUUID(), code: `RM-A-${tag}`, name: 'Hedione', alias: `FC-${tag}-2` },
  b: { id: randomUUID(), code: `RM-B-${tag}`, name: 'Iso E Super', alias: `FC-${tag}-3` },
};
const REQ = { single: randomUUID(), blend: randomUUID() };
let ruhUserId = '';

before(async () => {
  admin = postgres(dbUrl('postgres'), { max: 1, prepare: false, onnotice: () => {} });
  const [postgis] = await admin`select 1 from pg_available_extensions where name = 'postgis'`;
  if (!postgis) throw new Error('formula-setup e2e: needs a Postgres with PostGIS (point TEST_DATABASE_URL at 127.0.0.1:5433).');
  for (const db of [MAIN_DB, VAULT_DB]) {
    await admin.unsafe(`drop database if exists "${db}" with (force)`);
    await admin.unsafe(`create database "${db}"`);
  }
  const tsx = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  await run(tsx, ['scripts/db-migrate.ts'], { DATABASE_URL: MAIN_URL, SKIP_TARGETS: 'formula' });
  await run(tsx, ['scripts/db-migrate.ts'], { FORMULA_DATABASE_URL: VAULT_URL, SKIP_TARGETS: 'main' });
  // The real role catalogue (and its invariants: db-seed.ts asserts them and exits non-zero).
  await run(tsx, ['scripts/db-seed.ts'], { DATABASE_URL: MAIN_URL, BOOTSTRAP_OWNER_PASSWORD: randomUUID() });

  mainSql = postgres(MAIN_URL, { max: 2, prepare: false, onnotice: () => {} });
  vaultSql = postgres(VAULT_URL, { max: 2, prepare: false, onnotice: () => {} });

  for (const [key, p] of Object.entries(people)) {
    const email = `fs-${key}-${tag.toLowerCase()}@harness.invalid`;
    await mainSql`insert into iam.user_master (user_id, email, user_name, is_active, status, created_by, updated_by)
                  values (${p.id}, ${email}, ${key}, true, 'ACTIVE', 'test', 'test')`;
    await mainSql`insert into iam.user_role_mapping (user_id, role_id, status, created_by, updated_by)
                  select ${p.id}, role_id, 'ACTIVE', 'test', 'test' from iam.role_master where role_code = ${p.role}`;
  }
  for (const m of Object.values(MATS)) {
    await mainSql`insert into masterdata.material (material_id, material_code, material_name, status) values (${m.id}, ${m.code}, ${m.name}, 'ACTIVE')`;
    await mainSql`insert into masterdata.rm_alias (rm_alias_id, material_id, alias_name, alias_type, status) values (${randomUUID()}, ${m.id}, ${m.alias}, 'FLOOR_CODE', 'ACTIVE')`;
  }
  for (const p of [SINGLE, BLEND]) {
    await mainSql`insert into packaging.product_master (product_id, product_code, product_name, status) values (${p.productId}, ${p.code}, ${p.code + ' product'}, 'ACTIVE')`;
    await mainSql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, pack_size, status) values (${randomUUID()}, ${p.productId}, ${p.sku}, '25 kg', 'ACTIVE')`;
  }
  await mainSql`insert into platform.uom_master (uom_id, uom_code, uom_name) values (${randomUUID()}, 'kg', 'Kilogram') on conflict do nothing`;
  for (const [id, sku] of [[REQ.single, SINGLE.sku], [REQ.blend, BLEND.sku]] as const) {
    await mainSql`insert into bridge.production_requirement
      (alembic_requirement_id, org_id, correlation_id, order_ref, mapped_sku, qty, uom, pack_size, needed_by, priority,
       qty_kg, lot_policy, lifecycle_status, last_applied_version, last_emitted_version)
      values (${id}, ${randomUUID()}, ${randomUUID()}, ${'SO-' + id.slice(0, 6)}, ${sku}, 40, 'kg', '25 kg', '2099-01-01T00:00:00Z', 'normal',
              40, 'fifo', 'ACCEPTED', 1, 1)`;
  }

  sentinel = createNetServer((s) => { formulaDbConnects += 1; s.destroy(); });
  await new Promise<void>((r) => sentinel.listen(0, '127.0.0.1', r));
  const sentinelPort = (sentinel.address() as { port: number }).port;
  const mainPort = await freePort();
  const vaultPort = await freePort();
  mainApi = `http://127.0.0.1:${mainPort}`;
  vaultApi = `http://127.0.0.1:${vaultPort}`;
  vaultProc = startNode('backend/api/src/vault-main.ts', {
    APP_ENV: 'dev', VAULT_MODE: 'true', PORT: String(vaultPort), VAULT_BIND_HOST: '127.0.0.1',
    FORMULA_DATABASE_URL: VAULT_URL, FORMULA_KEK: KEK, JWT_SECRET, INTERNAL_BRIDGE_KEY: BRIDGE_KEY,
  });
  mainProc = startNode('backend/api/src/main.ts', {
    APP_ENV: 'dev', PORT: String(mainPort), DATABASE_URL: MAIN_URL,
    FORMULA_DATABASE_URL: `postgres://ra_vault@127.0.0.1:${sentinelPort}/vault`,
    JWT_SECRET, INTERNAL_BRIDGE_KEY: BRIDGE_KEY, VAULT_API_INTERNAL_URL: vaultApi,
    RUN_WORKER_IN_PROCESS: 'true', VAULT_CATALOGUE_SYNC_MS: '1000',
  });
  await Promise.all([waitHealthy(vaultApi, vaultProc, 'vault-main.ts'), waitHealthy(mainApi, mainProc, 'main.ts')]);

  // Access tokens as AuthService mints them: the roles, and (for the Vault box) the vault-scoped
  // permissions — JwtService.signAccess keeps only those. authTime = now (a fresh sign-in).
  const jwt = new JwtService(new ConfigService({ DATABASE_URL: MAIN_URL, JWT_SECRET } as NodeJS.ProcessEnv));
  const now = Math.floor(Date.now() / 1000);
  for (const p of Object.values(people)) {
    p.token = await jwt.signAccess({ sub: p.id, portal: 'owner', roles: [p.role], perms: grant(p.role), pv: 1, sid: randomUUID(), authTime: now });
  }
});

afterAll(async () => {
  await stop(mainProc);
  await stop(vaultProc);
  if (sentinel) await new Promise<void>((r) => sentinel.close(() => r()));
  await mainSql?.end({ timeout: 5 });
  await vaultSql?.end({ timeout: 5 });
  if (admin) {
    if (!KEEP) for (const db of [MAIN_DB, VAULT_DB]) await admin.unsafe(`drop database if exists "${db}" with (force)`);
    await admin.end({ timeout: 5 });
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(base: string, method: string, path: string, who: { token: string }, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${who.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const main = (method: string, path: string, who: { token: string }, body?: unknown) => call(mainApi, method, path, who, body);
const vault = (method: string, path: string, who: { token: string }, body?: unknown) => call(vaultApi, method, path, who, body);

test('1. two owners grant Ruh formulator — the requester cannot approve their own request, a second owner can', async () => {
  const before = await main('POST', '/v1/formula-setup/shells', people.production, { products: [{ productId: BLEND.productId, kind: 'blend' }] });
  assert.equal(before.status, 403, 'no shells before Ruh is granted');
  assert.match(before.json.error.message, /Ruh is not set up yet/);

  const req = await main('POST', '/v1/service-principals/ruh/formulator-request', people.ownerA, {});
  assert.equal(req.status, 201, JSON.stringify(req.json));
  assert.equal(req.json.data.formulator.state, 'pending');
  const requestId = req.json.data.formulator.requestId as string;
  ruhUserId = req.json.data.account.userId;
  assert.ok(req.json.data.formulator.approvers.some((a: { userId: string }) => a.userId === people.ownerB.id));

  const self = await main('POST', `/v1/vault-role-grant-requests/${requestId}/approve`, people.ownerA, {});
  assert.equal(self.status, 403);
  const ok = await main('POST', `/v1/vault-role-grant-requests/${requestId}/approve`, people.ownerB, {});
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const status = await main('GET', '/v1/service-principals/ruh', people.ownerA);
  assert.equal(status.json.data.formulator.state, 'active');
});

test('2. before any formula, Produce next is blocked: NO_FORMULA_LINK', async () => {
  const res = await main('POST', `/v1/produce/requirements/${REQ.blend}/plan`, people.production, {});
  assert.equal(res.status, 409, JSON.stringify(res.json));
  const [r] = await mainSql`select produce_block_reason from bridge.production_requirement where alembic_requirement_id = ${REQ.blend}`;
  assert.equal(r!.produce_block_reason, 'NO_FORMULA_LINK');
});

test('3. production drafts the shells as Ruh: both products linked; the block becomes NO_APPROVED_FORMULA', async () => {
  const list = await main('GET', '/v1/formula-setup/products', people.production);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const single = list.json.data.items.find((i: { productId: string }) => i.productId === SINGLE.productId);
  assert.equal(single.state, 'none');
  assert.ok(single.material, 'the single chemical\'s own material is found');
  assert.equal(single.material.materialCode, null, 'production holds no reveal: the material is masked');

  // The Vault checks a single chemical's material against the catalogue the main box pushes
  // (every VAULT_CATALOGUE_SYNC_MS); until the first push lands it answers 503 for that product.
  await eventually('the material catalogue reaches the Vault', 20_000, async () => {
    const r = await vault('GET', `/v1/vault/materials?q=${encodeURIComponent(MATS.single.code)}`, people.formulator);
    return r.status === 200 && r.json.data.length > 0 ? true : undefined;
  });
  const res = await main('POST', '/v1/formula-setup/shells', people.production, {
    products: [{ productId: SINGLE.productId, kind: 'single_chemical' }, { productId: BLEND.productId, kind: 'blend' }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.ok(res.json.data.results.every((r: { outcome: string }) => r.outcome === 'created'), JSON.stringify(res.json.data.results));
  const out = res.json.data.results as Array<{ productId: string; outcome: string; linked: boolean; state: string; formulaCode: string }>;
  assert.deepEqual(out.map((r) => [r.outcome, r.linked, r.state]).sort(), [['created', true, 'in_review'], ['created', true, 'recipe_needed']].sort());
  const linked = await mainSql`select product_id::text, formula_id::text from packaging.product_master where product_id in (${SINGLE.productId}, ${BLEND.productId})`;
  assert.ok(linked.every((l) => l.formula_id));
  // Drafted AS Ruh, on the Vault's own audit chain.
  const drafted = await vaultSql`select actor_id::text from formula.audit_events where action = 'formula.shell.drafted'`;
  assert.deepEqual([...new Set(drafted.map((d) => d.actor_id))], [ruhUserId]);
  const minted = await vaultSql`select 1 from formula.audit_events where action = 'security.service_token.minted' and entity_id = ${ruhUserId}`;
  assert.ok(minted.length >= 1);
  // Re-running is a no-op.
  const again = await main('POST', '/v1/formula-setup/shells', people.production, { products: [{ productId: BLEND.productId, kind: 'blend' }] });
  assert.equal(again.json.data.results[0].outcome, 'already_linked');

  const blocked = await main('POST', `/v1/produce/requirements/${REQ.single}/plan`, people.production, {});
  assert.equal(blocked.status, 409);
  const [r] = await mainSql`select produce_block_reason from bridge.production_requirement where alembic_requirement_id = ${REQ.single}`;
  assert.equal(r!.produce_block_reason, 'NO_APPROVED_FORMULA');
  const needs = await main('GET', '/v1/produce/formula-needs', people.approver);
  assert.ok(needs.json.data.some((n: { productCode: string }) => n.productCode === SINGLE.code));
  // The Factory's Formula dropdown route answers on the main box (codes only).
  const dir = await main('GET', '/v1/formulas?limit=50', people.production);
  assert.equal(dir.status, 200, JSON.stringify(dir.json));
  assert.ok(dir.json.data.some((f: { formulaCode: string }) => f.formulaCode === `F-${BLEND.code}`));
  assert.ok(!JSON.stringify(dir.json).includes('product'), 'no product/formula name crosses');
});

test('4. a formulator uploads the blend\'s recipe in the Vault: a typo is shown unmatched and nothing is sealed; the clean file seals as them', async () => {
  const typo = `product_code,material_code,percentage\n${BLEND.code},${MATS.a.code},60\n,RM-NOPE-${tag},40\n`;
  const preview = await eventually('the material catalogue reaches the Vault', 20_000, async () => {
    const r = await vault('POST', '/v1/formula-recipes/import', people.formulator, { csv: typo, commit: true });
    return r.status === 503 ? undefined : r;
  });
  assert.equal(preview.status, 201, JSON.stringify(preview.json));
  assert.equal(preview.json.data.committed, false);
  assert.match(preview.json.data.rows[1].error, /no material with code "RM-NOPE/);
  const sealedBefore = await vaultSql`select count(*)::int as n from formula.formula_ingredients i join formula.formula_version v using (formula_version_id) join formula.formula_product_link l using (formula_id) where l.product_id = ${BLEND.productId}`;
  assert.equal(sealedBefore[0]!.n, 0);

  const csv = `product_code,material_name,percentage\n${BLEND.code},hedione,60\n${BLEND.code},Iso E Super,40\n`;
  const done = await vault('POST', '/v1/formula-recipes/import', people.formulator, { csv, commit: true, submit: true });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.data.committed, true, JSON.stringify(done.json.data));
  const sealers = await vaultSql`select distinct i.created_by from formula.formula_ingredients i join formula.formula_version v using (formula_version_id) join formula.formula_product_link l using (formula_id) where l.product_id = ${BLEND.productId}`;
  assert.deepEqual(sealers.map((s) => s.created_by), [people.formulator.id]);

  // The formulator cannot approve anything; the Vault refuses the batch route outright.
  const refused = await vault('POST', '/v1/formula-versions/approve-batch', people.formulator, { versionIds: [randomUUID()] });
  assert.equal(refused.status, 403);
});

test('5. ONE approver approves both submitted versions in one request; each approval audited with that person', async () => {
  const queue = await vault('GET', '/v1/formula-review-queue', people.approver);
  assert.equal(queue.status, 200, JSON.stringify(queue.json));
  const mine = (queue.json.data as Array<{ productCode: string; formulaVersionId: string; blockedReason: string | null; authorId: string }>)
    .filter((q) => q.productCode === SINGLE.code || q.productCode === BLEND.code);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((q) => q.blockedReason === null && q.authorId === ruhUserId));
  const res = await vault('POST', '/v1/formula-versions/approve-batch', people.approver, { versionIds: mine.map((q) => q.formulaVersionId), remarks: 'setup batch' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.data.approved, 2);
  const audits = await vaultSql`select actor_id::text from formula.audit_events where action = 'formula.version.approved' and entity_id in ${vaultSql(mine.map((q) => q.formulaVersionId))}`;
  assert.equal(audits.length, 2);
  assert.ok(audits.every((a) => a.actor_id === people.approver.id));
});

test('6. Produce next now plans both runs; the masked pick list is right; the coded instruction shows floor codes; the blocks are gone', async () => {
  const single = await main('POST', `/v1/produce/requirements/${REQ.single}/plan`, people.production, {});
  assert.equal(single.status, 201, JSON.stringify(single.json));
  assert.deepEqual(single.json.data.formula, { code: `F-${SINGLE.code}`, version: 1 });
  const blend = await main('POST', `/v1/produce/requirements/${REQ.blend}/plan`, people.production, {});
  assert.equal(blend.status, 201, JSON.stringify(blend.json));

  const lines = async (orderId: string) => mainSql`select material_id::text, required_qty::text from production.production_order_ingredients where production_order_id = ${orderId} order by required_qty desc`;
  assert.deepEqual((await lines(single.json.data.productionOrderId)).map((l) => ({ ...l })), [{ material_id: MATS.single.id, required_qty: '40.0000' }]);
  assert.deepEqual((await lines(blend.json.data.productionOrderId)).map((l) => ({ ...l })), [
    { material_id: MATS.a.id, required_qty: '24.0000' },
    { material_id: MATS.b.id, required_qty: '16.0000' },
  ]);

  const released = await main('POST', `/v1/production-orders/${blend.json.data.productionOrderId}/pick-list`, people.production, {});
  assert.equal(released.status, 201, JSON.stringify(released.json));
  const instr = await main('GET', `/v1/production-orders/${blend.json.data.productionOrderId}/manufacturing-instruction`, people.production);
  assert.equal(instr.status, 200, JSON.stringify(instr.json));
  assert.deepEqual(instr.json.data.map((l: { code: string; quantity: number }) => [l.code, l.quantity]).sort(), [[MATS.a.alias, 24], [MATS.b.alias, 16]].sort());
  assert.ok(!JSON.stringify(instr.json).includes(MATS.a.name), 'the floor sees floor codes, never material names');

  const reqs = await mainSql`select produce_block_reason, production_order_id::text from bridge.production_requirement where alembic_requirement_id in (${REQ.single}, ${REQ.blend})`;
  assert.ok(reqs.every((r) => r.produce_block_reason === null && r.production_order_id));
  const needs = await main('GET', '/v1/produce/formula-needs', people.approver);
  assert.ok(!needs.json.data.some((n: { productCode: string }) => n.productCode === SINGLE.code || n.productCode === BLEND.code));
});

test('7. the main process never opened a connection to the formula database', () => {
  assert.equal(formulaDbConnects, 0);
});
