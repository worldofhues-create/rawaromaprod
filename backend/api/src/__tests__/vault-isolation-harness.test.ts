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
let mainBootedAt = 0;
let token = '';
const userId = randomUUID();

const materials = [
  { materialId: randomUUID(), rmAliasId: randomUUID(), alias: `ISO-${randomUUID().slice(0, 6)}-1`, percentage: 33.33333, sequenceNo: 1 },
  { materialId: randomUUID(), rmAliasId: randomUUID(), alias: `ISO-${randomUUID().slice(0, 6)}-2`, percentage: 12.34567, sequenceNo: 2 },
  { materialId: randomUUID(), rmAliasId: randomUUID(), alias: `ISO-${randomUUID().slice(0, 6)}-3`, percentage: 54.321, sequenceNo: 3 },
];
let approvedVersionId = '';
let draftVersionId = '';
let orderId = '';

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
    const f = await formulas.createFormula({ formulaCode: `ISO-${randomUUID().slice(0, 8)}`, formulaName: 'Isolation harness formula' }, author);
    const v = await formulas.createVersion({ formulaId: f.formulaId, versionNumber: 1 }, author);
    await formulas.addIngredients(
      v.formulaVersionId,
      { ingredients: materials.map((m) => ({ materialId: m.materialId, percentage: m.percentage, sequenceNo: m.sequenceNo })) },
      author,
    );
    if (approve) await approvals.approveVersion(v.formulaVersionId, {}, approver);
    return v.formulaVersionId;
  };
  approvedVersionId = await mk(true);
  draftVersionId = await mk(false);

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
  const vaultApi = `http://127.0.0.1:${vaultPort}`;

  vaultProc = startNode('backend/api/src/vault-main.ts', {
    APP_ENV: 'dev',
    VAULT_MODE: 'true',
    PORT: String(vaultPort),
    VAULT_BIND_HOST: '127.0.0.1',
    FORMULA_DATABASE_URL: VAULT_URL,
    FORMULA_KEK: KEK,
    JWT_SECRET,
    INTERNAL_BRIDGE_KEY: BRIDGE_KEY,
  });
  mainProc = startNode('backend/api/src/main.ts', {
    APP_ENV: 'dev',
    PORT: String(mainPort),
    DATABASE_URL: MAIN_URL,
    FORMULA_DATABASE_URL: `postgres://ra_vault@127.0.0.1:${sentinelPort}/vault`,
    JWT_SECRET,
    INTERNAL_BRIDGE_KEY: BRIDGE_KEY,
    VAULT_API_INTERNAL_URL: vaultApi,
    RUN_WORKER_IN_PROCESS: 'true',
  });
  await Promise.all([waitHealthy(vaultApi, vaultProc, 'vault-main.ts'), waitHealthy(mainApi, mainProc, 'main.ts')]);
  mainBootedAt = Date.now();

  const jwt = new JwtService(new ConfigService({ DATABASE_URL: MAIN_URL, JWT_SECRET } as NodeJS.ProcessEnv));
  const now = Math.floor(Date.now() / 1000);
  token = await jwt.signAccess({ sub: userId, portal: 'owner', roles: [roleCode], perms: [], pv: 1, sid: randomUUID(), authTime: now });
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

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${mainApi}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
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

test('the main process (API + in-process worker) never opened a connection to the formula database', async () => {
  // Let the in-process worker run several outbox-drain ticks (2 s) and a notifier poll (5 s)
  // past boot: the old worker polled formula.outbox through the formula pool on every tick.
  const settle = 7_000 - (Date.now() - mainBootedAt);
  if (settle > 0) await new Promise((r) => setTimeout(r, settle));
  assert.equal(mainProc!.child.exitCode, null, 'main.ts is still running');
  assert.equal(formulaDbConnects, 0, `main.ts connected to the formula DB ${formulaDbConnects} time(s)`);
  assert.doesNotMatch(mainProc!.log(), /CONNECT_TIMEOUT|formula\.outbox" does not exist/);
});
