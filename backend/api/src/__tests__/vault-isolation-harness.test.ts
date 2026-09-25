/**
 * Vault isolation harness (RawProd release blocker, lane vaultport-rp) — the production shape, on
 * one machine: two databases that cannot see each other, the REAL `main.ts` and the REAL
 * `vault-main.ts` as two separate processes on two ports, and the main API's formula-database URL
 * pointing at a watched port where nothing answers.
 *
 *   main.ts (APP_ENV=dev, RUN_WORKER_IN_PROCESS=true)
 *     DATABASE_URL          -> <test db>_iso_main   (migrated like prod: SKIP_TARGETS=formula)
 *     FORMULA_DATABASE_URL  -> 127.0.0.1:<sentinel> (a TCP listener that only counts connects)
 *     VAULT_API_INTERNAL_URL-> vault-main.ts
 *   vault-main.ts (VAULT_MODE=true, no DATABASE_URL)
 *     FORMULA_DATABASE_URL  -> <test db>_iso_vault  (migrated like prod: SKIP_TARGETS=main)
 *     no MAIN_API_INTERNAL_URL — like prod's and demo's vault.env: the Vault cannot call back into
 *     the main box, so every production read must be answerable from the Vault's side alone.
 *
 * Before the fix, `POST /v1/production-orders` read the pick list through the main process's own
 * formula-DB pool and died with CONNECT_TIMEOUT (seen live on DEMO); local tests never caught it
 * because both schemas sat in one Postgres. Here the approved formula exists ONLY in the vault
 * database, so the order can only succeed through the Vault API, and the sentinel proves the main
 * process (API + in-process worker, across several outbox-drain ticks) never opened a single
 * connection to the formula database. The resulting production_order_ingredients must equal what
 * the old in-process path stored: material_id + Postgres's numeric(18,4) of
 * String((orderQty * percentage) / 100), in sequence order. The order's §109.7 coded manufacturing
 * instruction must come back with the materials' floor codes and the same quantities, also with no
 * Vault -> main call.
 *
 * Lane fread-rp extends it to the main box's remaining formula READS and the Vault console's two
 * screens that needed the other box's data, all with the same two-process / two-database shape:
 *   - GET /v1/dashboard — runs, formula stage, feed: formula codes/statuses/event types from the
 *     Vault over the signed channel; never the formula name (it is only in the vault database).
 *   - GET /v1/trace/finished-good/:id — the product's formula code from the Vault.
 *   - GET /v1/formula-access-audit on the main box — the Vault's audit page + this box's emails.
 *   - GET /v1/formula-access-audit on the VAULT box — the Vault console's access-audit screen.
 *   - GET /v1/vault/materials on the VAULT box — the material picker, answered from the catalogue
 *     the main box's worker PUSHES (VAULT_CATALOGUE_SYNC_MS=1000 here); the Vault never calls back.
 * The formula-DB sentinel's count stays 0 across all of it.
 *
 * Needs a Postgres with PostGIS (the real migrations create it) where the test role may create
 * databases — the Docker PostGIS at 127.0.0.1:5433 the gates use. Its two databases are dropped
 * and re-created on each run (KEEP_ISO_DBS=1 keeps them afterwards for debugging).
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as formulaSchema from '@ra/data-formula';
import * as masterdataSchema from '@ra/data-masterdata';
import { ConfigService, JwtService } from '@core/backend-kernel';
import { EnvKmsAdapter } from '../../../cluster-formula/src/crypto/env-kms.adapter.js';
import { VaultService } from '../../../cluster-formula/src/vault.service.js';
import { FormulasService } from '../../../cluster-formula/src/formulas/formulas.service.js';
import { ApprovalsService } from '../../../cluster-formula/src/approvals/approvals.service.js';
import { MasterdataLookupService } from '../../../cluster-masterdata/src/masterdata-lookup.service.js';
import { principal } from '../../../test-support/db.js';

const REPO_ROOT = process.cwd(); // run-tests.mjs spawns `node --test` with cwd: repoRoot
const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_rp_policy_test';
const KEEP = process.env.KEEP_ISO_DBS === '1';

const KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const JWT_SECRET = `iso-harness-${'j'.repeat(32)}`;
const BRIDGE_KEY = `iso-harness-${'b'.repeat(32)}`;
const ORDER_QTY = 7.3;

function dbUrl(name: string): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}
const baseName = new URL(BASE_URL).pathname.replace(/^\//, '') || 'rawprod_test';
const MAIN_DB = `${baseName}_iso_main`.slice(0, 63);
const VAULT_DB = `${baseName}_iso_vault`.slice(0, 63);
const MAIN_URL = dbUrl(MAIN_DB);
const VAULT_URL = dbUrl(VAULT_DB);

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  if (!addr || typeof addr === 'string') throw new Error('no port');
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
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
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
    try {
      const res = await fetch(`${url}/health`);
      if (res.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} never became healthy:\n${proc.log().slice(-4000)}`);
}

async function stop(proc: Proc | undefined): Promise<void> {
  if (!proc || proc.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.child.once('exit', () => resolve()));
  proc.child.kill('SIGTERM');
  const timer = setTimeout(() => proc.child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
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
let mainBootedAt = 0;
let token = '';
const userId = randomUUID();
/** A Vault-authority user (formula:actual:read + the picker), for the reads the production role may not make. */
let vaultToken = '';
const vaultUserId = randomUUID();
const USER_EMAIL = `iso-prod-${randomUUID().slice(0, 8)}@harness.invalid`;
const FORMULA_NAME = 'Isolation harness formula';
let vaultProcEnv: Record<string, string> = {};

const materials = [
  { materialId: randomUUID(), rmAliasId: randomUUID(), alias: `ISO-${randomUUID().slice(0, 6)}-1`, percentage: 33.33333, sequenceNo: 1 },
  { materialId: randomUUID(), rmAliasId: randomUUID(), alias: `ISO-${randomUUID().slice(0, 6)}-2`, percentage: 12.34567, sequenceNo: 2 },
  { materialId: randomUUID(), rmAliasId: randomUUID(), alias: `ISO-${randomUUID().slice(0, 6)}-3`, percentage: 54.321, sequenceNo: 3 },
];
let approvedVersionId = '';
let approvedFormulaId = '';
let approvedFormulaCode = '';
let draftVersionId = '';
let orderId = '';
let vaultRoleCode = '';

before(async () => {
  admin = postgres(dbUrl('postgres'), { max: 1, prepare: false, onnotice: () => {} });
  const [postgis] = await admin`select 1 from pg_available_extensions where name = 'postgis'`;
  if (!postgis) {
    throw new Error(
      `vault isolation harness: ${new URL(BASE_URL).host} has no PostGIS, which the real migrations need — ` +
        'point TEST_DATABASE_URL at the Docker PostGIS (127.0.0.1:5433).',
    );
  }
  for (const db of [MAIN_DB, VAULT_DB]) {
    await admin.unsafe(`drop database if exists "${db}" with (force)`);
    await admin.unsafe(`create database "${db}"`);
  }

  // Migrate each database exactly as production does, each side unable to see the other.
  const tsx = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  await run(tsx, ['scripts/db-migrate.ts'], { DATABASE_URL: MAIN_URL, SKIP_TARGETS: 'formula' });
  await run(tsx, ['scripts/db-migrate.ts'], { FORMULA_DATABASE_URL: VAULT_URL, SKIP_TARGETS: 'main' });

  mainSql = postgres(MAIN_URL, { max: 2, prepare: false, onnotice: () => {} });
  vaultSql = postgres(VAULT_URL, { max: 2, prepare: false, onnotice: () => {} });

  // Main database: the materials, their floor codes, and a role that may create production orders.
  for (const m of materials) {
    await mainSql`insert into masterdata.material (material_id, material_code, material_name, status)
                  values (${m.materialId}, ${`ISO-MAT-${m.sequenceNo}`}, 'Isolation harness material', 'ACTIVE')`;
    await mainSql`insert into masterdata.rm_alias (rm_alias_id, material_id, alias_name, alias_type, status)
                  values (${m.rmAliasId}, ${m.materialId}, ${m.alias}, 'FLOOR_CODE', 'ACTIVE')`;
  }
  const roleId = randomUUID();
  const roleCode = `iso-prod-${randomUUID().slice(0, 8)}`;
  await mainSql`insert into iam.role_master (role_id, role_code, role_name, status) values (${roleId}, ${roleCode}, ${roleCode}, 'ACTIVE')`;
  for (const code of [
    'production:production_order:write',
    'production:production_order:read',
    'production:material_pick_list:write',
    'production:manufacturing_instruction:read',
  ]) {
    const permissionId = randomUUID();
    await mainSql`insert into iam.permission_master (permission_id, permission_code, permission_name, status)
                  values (${permissionId}, ${code}, ${code}, 'ACTIVE')`;
    await mainSql`insert into iam.role_permission_mapping (role_id, permission_id, status) values (${roleId}, ${permissionId}, 'ACTIVE')`;
  }
  // A Vault-authority role (as a formulator holds): the Vault reads' permission + the trace's.
  const vaultRoleId = randomUUID();
  vaultRoleCode = `iso-vault-${randomUUID().slice(0, 8)}`;
  await mainSql`insert into iam.role_master (role_id, role_code, role_name, status) values (${vaultRoleId}, ${vaultRoleCode}, ${vaultRoleCode}, 'ACTIVE')`;
  for (const code of ['formula:actual:read', 'vault:material_search:read', 'packaging:finished_good_batch_master:read']) {
    const permissionId = randomUUID();
    await mainSql`insert into iam.permission_master (permission_id, permission_code, permission_name, status)
                  values (${permissionId}, ${code}, ${code}, 'ACTIVE')`;
    await mainSql`insert into iam.role_permission_mapping (role_id, permission_id, status) values (${vaultRoleId}, ${permissionId}, 'ACTIVE')`;
  }
  // The production user's directory entry (only the main database has one).
  await mainSql`insert into iam.user_master (user_id, email, user_name, status) values (${userId}, ${USER_EMAIL}, 'Isolation harness user', 'ACTIVE')`;

  // Vault database ONLY: one approved formula version, one draft. The seed runs the Vault's own
  // services, like demo-seed-vault.ts does on the vault box.
  const config = new ConfigService({ DATABASE_URL: MAIN_URL, JWT_SECRET, FORMULA_KEK: KEK } as NodeJS.ProcessEnv);
  const kms = new EnvKmsAdapter(config);
  const formulaDb = drizzle(vaultSql, { schema: formulaSchema });
  const vault = new VaultService(formulaDb as never, kms);
  const lookup = new MasterdataLookupService(drizzle(mainSql, { schema: masterdataSchema }) as never);
  const formulas = new FormulasService(formulaDb as never, kms, vault, lookup);
  const approvals = new ApprovalsService(formulaDb as never, vault);
  const author = principal({ userId: randomUUID() });
  const approver = principal({ userId: randomUUID() });
  const mk = async (approve: boolean) => {
    const f = await formulas.createFormula({ formulaCode: `ISO-${randomUUID().slice(0, 8)}`, formulaName: FORMULA_NAME }, author);
    const v = await formulas.createVersion({ formulaId: f.formulaId, versionNumber: 1 }, author);
    await formulas.addIngredients(
      v.formulaVersionId,
      { ingredients: materials.map((m) => ({ materialId: m.materialId, percentage: m.percentage, sequenceNo: m.sequenceNo })) },
      author,
    );
    if (approve) await approvals.approveVersion(v.formulaVersionId, {}, approver);
    return { versionId: v.formulaVersionId, formulaId: f.formulaId, formulaCode: f.formulaCode as string };
  };
  const approved = await mk(true);
  approvedVersionId = approved.versionId;
  approvedFormulaId = approved.formulaId;
  approvedFormulaCode = approved.formulaCode;
  draftVersionId = (await mk(false)).versionId;

  // The formula DB the main process is TOLD about: a listener that only counts connection attempts.
  sentinel = createNetServer((socket) => {
    formulaDbConnects += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
  const sentinelPort = (sentinel.address() as { port: number }).port;

  const mainPort = await freePort();
  const vaultPort = await freePort();
  mainApi = `http://127.0.0.1:${mainPort}`;
  vaultApi = `http://127.0.0.1:${vaultPort}`;

  // Like prod's vault.env: no DATABASE_URL and no MAIN_API_INTERNAL_URL — no way to the main box.
  vaultProcEnv = {
    APP_ENV: 'dev',
    VAULT_MODE: 'true',
    PORT: String(vaultPort),
    VAULT_BIND_HOST: '127.0.0.1',
    FORMULA_DATABASE_URL: VAULT_URL,
    FORMULA_KEK: KEK,
    JWT_SECRET,
    INTERNAL_BRIDGE_KEY: BRIDGE_KEY,
  };
  vaultProc = startNode('backend/api/src/vault-main.ts', vaultProcEnv);
  mainProc = startNode('backend/api/src/main.ts', {
    APP_ENV: 'dev',
    PORT: String(mainPort),
    DATABASE_URL: MAIN_URL,
    FORMULA_DATABASE_URL: `postgres://ra_vault@127.0.0.1:${sentinelPort}/vault`,
    JWT_SECRET,
    INTERNAL_BRIDGE_KEY: BRIDGE_KEY,
    VAULT_API_INTERNAL_URL: vaultApi,
    RUN_WORKER_IN_PROCESS: 'true',
    // The worker's material-catalogue push to the Vault's picker, every second here (15 s default).
    VAULT_CATALOGUE_SYNC_MS: '1000',
  });
  await Promise.all([waitHealthy(vaultApi, vaultProc, 'vault-main.ts'), waitHealthy(mainApi, mainProc, 'main.ts')]);
  mainBootedAt = Date.now();

  const jwt = new JwtService(new ConfigService({ DATABASE_URL: MAIN_URL, JWT_SECRET } as NodeJS.ProcessEnv));
  const now = Math.floor(Date.now() / 1000);
  token = await jwt.signAccess({ sub: userId, portal: 'owner', roles: [roleCode], perms: [], pv: 1, sid: randomUUID(), authTime: now });
  // As the main box's AuthService mints it: roles + the vault-scoped permissions the Vault box reads.
  vaultToken = await jwt.signAccess({
    sub: vaultUserId, portal: 'owner', roles: [vaultRoleCode],
    perms: ['formula:actual:read', 'vault:material_search:read'], pv: 1, sid: randomUUID(), authTime: now,
  });
});

afterAll(async () => {
  await stop(mainProc);
  await stop(vaultProc);
  if (sentinel) await new Promise<void>((resolve) => sentinel.close(() => resolve()));
  await mainSql?.end({ timeout: 5 });
  await vaultSql?.end({ timeout: 5 });
  if (admin) {
    if (!KEEP) for (const db of [MAIN_DB, VAULT_DB]) await admin.unsafe(`drop database if exists "${db}" with (force)`);
    await admin.end({ timeout: 5 });
  }
});

async function api(method: string, path: string, body?: unknown, opts: { base?: string; bearer?: string } = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${opts.base ?? mainApi}${path}`, {
    method,
    headers: { authorization: `Bearer ${opts.bearer ?? token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The Vault console's calls: the Vault box, the Vault-authority user's token. */
const vaultConsole = (path: string, bearer = vaultToken) => api('GET', path, undefined, { base: vaultApi, bearer });

/** Poll until `probe` returns a value, or fail after `ms`. */
async function eventually<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what}: not within ${ms} ms${last ? ` (${(last as Error).message})` : ''}`);
}

test('the main API boots and serves with no formula database reachable', async () => {
  const res = await fetch(`${mainApi}/health`);
  assert.equal(res.status, 200);
  assert.equal(formulaDbConnects, 0);
});

test('POST /v1/production-orders succeeds through the Vault API and stores the same pick list as the old in-process path', async () => {
  const res = await api('POST', '/v1/production-orders', { formulaVersionId: approvedVersionId, orderQty: ORDER_QTY });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.data.ingredientCount, materials.length);
  orderId = res.json.data.order.productionOrderId as string;

  const stored = await mainSql<{ material_id: string; required_qty: string }[]>`
    select material_id::text, required_qty::text from production.production_order_ingredients
     where production_order_id = ${orderId} order by production_order_ingredient_id`;
  // The old path: material_id + Postgres's numeric(18,4) of String((orderQty * percentage) / 100).
  const expected = [];
  for (const m of materials) {
    const [row] = await mainSql<{ q: string }[]>`select ${String((ORDER_QTY * m.percentage) / 100)}::numeric(18,4)::text as q`;
    expected.push({ material_id: m.materialId, required_qty: row!.q });
  }
  assert.deepEqual(stored.map((r) => ({ ...r })), expected);
  assert.deepEqual(expected.map((e) => e.required_qty), ['2.4333', '0.9012', '3.9654']);

  const [order] = await mainSql<{ status: string; formula_version_id: string }[]>`
    select status, formula_version_id::text from production.production_order where production_order_id = ${orderId}`;
  assert.deepEqual({ ...order }, { status: 'PLANNING', formula_version_id: approvedVersionId });
  const events = await mainSql`select 1 from production.outbox where aggregate_id = ${orderId} and type = 'production.order.created'`;
  assert.equal(events.length, 1);

  // The read happened on the Vault, audited there, for this user.
  const audit = await vaultSql<{ actor_id: string }[]>`
    select actor_id::text from formula.audit_events where action = 'formula.picklist.read' and entity_id = ${approvedVersionId}`;
  assert.deepEqual(audit.map((a) => a.actor_id), [userId]);
});

test('the order\'s coded manufacturing instruction: floor codes + the same quantities, with no Vault -> main call', async () => {
  assert.ok(orderId, 'depends on the production-order test above');
  const released = await api('POST', `/v1/production-orders/${orderId}/pick-list`, {});
  assert.equal(released.status, 201, JSON.stringify(released.json));
  const res = await api('GET', `/v1/production-orders/${orderId}/manufacturing-instruction`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(
    res.json.data,
    materials.map((m) => ({
      code: m.alias,
      quantity: Math.round((m.percentage / 100) * ORDER_QTY * 1000) / 1000,
      uom: 'kg',
      sequenceNo: m.sequenceNo,
    })),
  );
  const audit = await vaultSql`
    select 1 from formula.audit_events
     where action = 'formula.manufacturing_instruction.resolve' and entity_id = ${approvedVersionId} and actor_id = ${userId}`;
  assert.equal(audit.length, 1);
});

test('a formula version that is not approved is still refused (403), and nothing is created', async () => {
  const before = await mainSql`select count(*)::int as n from production.production_order`;
  const res = await api('POST', '/v1/production-orders', { formulaVersionId: draftVersionId, orderQty: ORDER_QTY });
  assert.equal(res.status, 403, JSON.stringify(res.json));
  const after = await mainSql`select count(*)::int as n from production.production_order`;
  assert.equal(after[0]!.n, before[0]!.n);
});

test('a sensitive refusal on the main API is audited on the Vault, over the API', async () => {
  const res = await api('GET', '/v1/formula-access-audit');
  assert.equal(res.status, 403);
  const deadline = Date.now() + 10_000;
  let rows: ReadonlyArray<unknown> = [];
  while (Date.now() < deadline) {
    rows = await vaultSql`select 1 from formula.audit_events where action = 'security.permission.denied' and actor_id = ${userId}`;
    if (rows.length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(rows.length, 1, 'the refusal must land on the Vault\'s audit chain');
});

/* ── lane fread-rp: the main box's remaining formula reads, and the Vault console's two screens ── */

test('GET /v1/dashboard: runs carry the formula code + version from the Vault; never the formula name', async () => {
  assert.ok(orderId, 'depends on the production-order test above');
  // The order's oil batch, so the run is recognisable in the runs table.
  const oilBatch = `ISO-OIL-${randomUUID().slice(0, 6)}`;
  await mainSql`insert into production.oil_batch_master (oil_batch_id, production_order_id, batch_number, produced_qty, status)
                values (${randomUUID()}, ${orderId}, ${oilBatch}, ${ORDER_QTY}, 'ACTIVE')`;

  const holder = await api('GET', '/v1/dashboard', undefined, { bearer: vaultToken });
  assert.equal(holder.status, 200, JSON.stringify(holder.json));
  const run = holder.json.data.runs.find((r: { batch: string }) => r.batch === oilBatch);
  assert.ok(run, JSON.stringify(holder.json.data.runs));
  assert.equal(run.product, `${approvedFormulaCode} v1`);
  assert.equal(holder.json.data.reveal.product, true);
  // The formula stage lists the Vault's codes; the feed shows its lifecycle events by type.
  assert.ok(holder.json.data.flow.formula.codes.some((c: { code: string }) => c.code === approvedFormulaCode));
  assert.ok(holder.json.data.feed.some((f: { text: string }) => f.text === 'version approved'), JSON.stringify(holder.json.data.feed));
  assert.doesNotMatch(JSON.stringify(holder.json), new RegExp(FORMULA_NAME), 'the formula name never reaches the main box');

  const production = await api('GET', '/v1/dashboard');
  assert.equal(production.status, 200);
  const masked = production.json.data.runs.find((r: { batch: string }) => r.batch === oilBatch);
  assert.equal(masked.product, 'Protected ◆', 'no formula:actual:read, same mask as before');
  assert.doesNotMatch(JSON.stringify(production.json), new RegExp(FORMULA_NAME));
});

test('GET /v1/trace/finished-good/:id: the finished good\'s product is its formula code, from the Vault', async () => {
  assert.ok(orderId);
  const [oil] = await mainSql<{ oil_batch_id: string }[]>`
    select oil_batch_id::text from production.oil_batch_master where production_order_id = ${orderId} limit 1`;
  assert.ok(oil, 'depends on the dashboard test above');
  const productId = randomUUID();
  const skuId = randomUUID();
  const packageOrderId = randomUUID();
  const fgId = randomUUID();
  // The factory product references the Vault's formula by id only; it has no name of its own.
  await mainSql`insert into packaging.product_master (product_id, product_code, product_name, formula_id, status)
                values (${productId}, ${`ISO-PRD-${randomUUID().slice(0, 6)}`}, null, ${approvedFormulaId}, 'ACTIVE')`;
  await mainSql`insert into packaging.product_sku (product_sku_id, product_id, sku_code, status)
                values (${skuId}, ${productId}, ${`ISO-SKU-${randomUUID().slice(0, 6)}`}, 'ACTIVE')`;
  await mainSql`insert into packaging.package_order (package_order_id, product_sku_id, oil_batch_id, status)
                values (${packageOrderId}, ${skuId}, ${oil.oil_batch_id}, 'ACTIVE')`;
  await mainSql`insert into packaging.finished_good_batch_master (finished_good_batch_id, package_order_id, product_sku_id, batch_number, status)
                values (${fgId}, ${packageOrderId}, ${skuId}, ${`ISO-FG-${randomUUID().slice(0, 6)}`}, 'ACTIVE')`;

  const res = await api('GET', `/v1/trace/finished-good/${fgId}`, undefined, { bearer: vaultToken });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.finishedGood.product, approvedFormulaCode);
  assert.equal(res.json.data.oilBatch.qty, ORDER_QTY);
  assert.equal(res.json.data.materialCount, materials.length);
  assert.doesNotMatch(JSON.stringify(res.json), new RegExp(FORMULA_NAME));
});

test('the Vault console\'s access-audit screen: GET /v1/formula-access-audit on the VAULT box, from its own chain', async () => {
  const res = await vaultConsole('/v1/formula-access-audit?limit=200');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const rows = res.json.data as Array<{ action: string; entityId: string | null; actorId: string | null; result: string; actor: string | null }>;
  const pick = rows.find((r) => r.action === 'formula.picklist.read' && r.entityId === approvedVersionId);
  assert.ok(pick, 'the production order\'s pick-list read');
  assert.equal(pick.actorId, userId);
  assert.equal(pick.actor, null, 'the Vault has no user directory');
  assert.ok(rows.some((r) => r.action === 'security.permission.denied' && r.actorId === userId && r.result === 'refuse'));
  // The screen's own reader (web-vault/vault.js) over this exact response: the envelope hands it
  // the rows array (a page's `.items` never reaches the client), which it must render.
  const src = readFileSync(join(REPO_ROOT, 'web-vault/vault.js'), 'utf8');
  const reader = /function pageItems\(page\) \{[^\n]*\}/.exec(src);
  assert.ok(reader, 'web-vault/vault.js defines pageItems');
  const pageItems = new Function(`${reader[0]}; return pageItems;`)() as (p: unknown) => typeof rows;
  assert.equal((res.json.data as { items?: unknown }).items, undefined);
  assert.ok(pageItems(res.json.data).some((r) => r.action === 'formula.picklist.read' && r.entityId === approvedVersionId));
  assert.doesNotMatch(src, /page\.items \|\| \[\]/, 'no screen reads rows off .items any more');
  // Same permission as the screen: the production user's token carries no formula:actual:read.
  assert.equal((await vaultConsole('/v1/formula-access-audit', token)).status, 403);
});

test('GET /v1/formula-access-audit on the MAIN box: the Vault\'s page over the signed channel, emails from this box', async () => {
  const res = await api('GET', '/v1/formula-access-audit?limit=200', undefined, { bearer: vaultToken });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const pick = (res.json.data as Array<{ action: string; entityId: string | null; actor: string | null }>)
    .find((r) => r.action === 'formula.picklist.read' && r.entityId === approvedVersionId);
  assert.ok(pick);
  assert.equal(pick.actor, USER_EMAIL);
  const firstPage = await api('GET', '/v1/formula-access-audit?limit=1', undefined, { bearer: vaultToken });
  assert.equal(firstPage.json.data.length, 1);
  assert.equal(firstPage.json.meta.cursor, '1');
});

test('the Vault console\'s material picker: GET /v1/vault/materials on the VAULT box, from the catalogue the main box pushes', async () => {
  // The Vault process has no way to the main box: no main DB, no main API URL.
  assert.equal(vaultProcEnv.DATABASE_URL, undefined);
  assert.equal(vaultProcEnv.MAIN_API_INTERNAL_URL, undefined);

  const hits = await eventually('the pushed catalogue on the Vault', 30_000, async () => {
    const res = await vaultConsole('/v1/vault/materials?q=ISO-MAT&limit=20');
    return res.status === 200 && res.json.data.length === materials.length ? res.json.data : undefined;
  });
  assert.deepEqual(
    hits.map((h: { materialId: string; materialCode: string }) => [h.materialCode, h.materialId]),
    materials.map((m) => [`ISO-MAT-${m.sequenceNo}`, m.materialId]),
  );
  assert.deepEqual(Object.keys(hits[0]).sort(), ['materialCode', 'materialId', 'materialName', 'uomId']);
  assert.doesNotMatch(JSON.stringify(hits), /ISO-[0-9a-f]{6}-\d/, 'no floor code (RM alias) is pushed to the Vault');

  // A material added on the factory reaches the picker on the worker's next round.
  const added = randomUUID();
  await mainSql`insert into masterdata.material (material_id, material_code, material_name, status)
                values (${added}, 'ISO-MAT-4', 'Isolation harness material added later', 'ACTIVE')`;
  await eventually('the new material on the Vault', 30_000, async () => {
    const res = await vaultConsole('/v1/vault/materials?q=ISO-MAT-4');
    return res.status === 200 && res.json.data.some((m: { materialId: string }) => m.materialId === added) ? true : undefined;
  });

  // Same permission as the picker: the production user's token carries no vault:material_search:read.
  assert.equal((await vaultConsole('/v1/vault/materials?q=ISO-MAT', token)).status, 403);
});

test('the main process (API + in-process worker) never opened a connection to the formula database', async () => {
  // Let the in-process worker run several outbox-drain ticks (2 s) and a notifier poll (5 s)
  // past boot: the old worker polled formula.outbox through the formula pool on every tick.
  const settle = 7_000 - (Date.now() - mainBootedAt);
  if (settle > 0) await new Promise((r) => setTimeout(r, settle));
  assert.equal(mainProc!.child.exitCode, null, 'main.ts is still running');
  assert.equal(formulaDbConnects, 0, `main.ts connected to the formula DB ${formulaDbConnects} time(s)`);
  assert.doesNotMatch(mainProc!.log(), /CONNECT_TIMEOUT|formula\.outbox" does not exist/);
});
