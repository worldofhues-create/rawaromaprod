/**
 * RC7 item 2 — the application role can use the `automation` schema, by migration.
 *
 * 0020_adhoc_g3_automation.sql created `automation` as the migrating owner and granted nothing, so on production
 * the DML-only app role (rawprod_app) could not touch automation.applied and all four automation drains failed
 * from 2026-09-24 until P0 granted the schema by hand on 2026-09-25. scripts/migrations/
 * 2026-09-26-automation-app-role-grants.sql makes that grant permanent, to the role named by DB_APP_ROLE (which
 * scripts/db-migrate.ts hands every block as `rawprod.app_role`; production's migrate.env renders it).
 *
 * Real migrations on a real database (the Docker PostGIS the gates use), migrated twice exactly as production is
 * (SKIP_TARGETS=formula) with DB_APP_ROLE set to a throwaway NOLOGIN role; then the privileges are read back from
 * the catalog AND exercised as that role (SET ROLE) with the statements the automation ledger runs.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { APP_ROLE_SETTING, splitByTarget } from '../../../../scripts/db-migrate.js';

const REPO_ROOT = process.cwd(); // run-tests.mjs spawns `node --test` with cwd: repoRoot
const MIGRATION = 'scripts/migrations/2026-09-26-automation-app-role-grants.sql';
const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://apple@localhost:5432/rawprod_rp_policy_test';
const dbUrl = (name: string) => { const u = new URL(BASE_URL); u.pathname = `/${name}`; return u.toString(); };
const BASE = new URL(BASE_URL).pathname.replace(/^\//, '') || 'rawprod_test';
const DB = `${BASE}_app_grants`.slice(0, 63);
// Roles are cluster-wide: named after this lane's own test database so two lanes never share one.
const APP = `${BASE}_app`.slice(0, 63);
const OTHER = `${BASE}_unset`.slice(0, 63);

let admin: Sql;
let sql: Sql;

function migrate(env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(REPO_ROOT, 'node_modules', '.bin', 'tsx'), ['scripts/db-migrate.ts'], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: dbUrl(DB), SKIP_TARGETS: 'formula', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`db-migrate exited ${code}:\n${out.slice(-4000)}`))));
  });
}

async function dropAll(): Promise<void> {
  await admin.unsafe(`drop database if exists "${DB}" with (force)`);
  for (const r of [APP, OTHER]) await admin.unsafe(`drop role if exists "${r}"`);
}

/** The migration's one main block, run directly (bypassing the ledger) with the setting as given. */
async function runBlock(role: string): Promise<void> {
  const [block] = splitByTarget(readFileSync(join(REPO_ROOT, MIGRATION), 'utf8'));
  assert.equal(block?.target, 'main');
  await sql.begin(async (tx) => {
    await tx`select set_config(${APP_ROLE_SETTING}, ${role}, true)`;
    await tx.unsafe(block!.sql);
  });
}

const tables = async () =>
  (await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'automation' and c.relkind in ('r', 'p') order by 1`).map((r) => String(r.relname));

before(async () => {
  admin = postgres(dbUrl('postgres'), { max: 1, prepare: false, onnotice: () => {} });
  const [postgis] = await admin`select 1 from pg_available_extensions where name = 'postgis'`;
  if (!postgis) throw new Error(`${new URL(BASE_URL).host} has no PostGIS, which the real migrations need -- use the Docker PostGIS (127.0.0.1:5433).`);
  await dropAll();
  await admin.unsafe(`create role "${APP}" nologin`);
  await admin.unsafe(`create role "${OTHER}" nologin`);
  await admin.unsafe(`create database "${DB}"`);
  await migrate({ DB_APP_ROLE: APP });
  const second = await migrate({ DB_APP_ROLE: APP });
  // The runner prints "== <file> ==" then "-> @target: main (<result>)" per block (notices may sit between).
  const section = second.split('\n== ').find((s) => s.startsWith('2026-09-26-automation-app-role-grants.sql =='));
  assert.match(section ?? '', /-> @target: main \(skipped\)/, 'the second run finds it in the ledger');
  sql = postgres(dbUrl(DB), { max: 2, prepare: false, onnotice: () => {} });
});

after(async () => {
  await sql?.end({ timeout: 1 });
  if (admin) {
    await dropAll();
    await admin.end({ timeout: 1 });
  }
});

test('DB_APP_ROLE gets USAGE on automation and DML on every automation table, and nothing elsewhere', async () => {
  const [usage] = await sql`select has_schema_privilege(${APP}, 'automation', 'USAGE') as ok`;
  assert.equal(usage?.ok, true);
  const names = await tables();
  assert.deepEqual(names, ['applied', 'dead_letter', 'decision_log'], 'the automation tables 0020 creates');
  for (const t of names) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const [r] = await sql`select has_table_privilege(${APP}, ${'automation.' + t}, ${priv}) as ok`;
      assert.equal(r?.ok, true, `${priv} on automation.${t}`);
    }
  }
  // Scoped to automation: the migration grants no other schema (production's are granted at provisioning).
  const [other] = await sql`select has_schema_privilege(${APP}, 'procurement', 'USAGE') as ok`;
  assert.equal(other?.ok, false);
  // DML only: no DDL on the schema.
  const [create] = await sql`select has_schema_privilege(${APP}, 'automation', 'CREATE') as ok`;
  assert.equal(create?.ok, false);
});

test('as the app role, the automation ledger statements run (claim, finish, decision log, dead letter)', async () => {
  const key = `grants-${Date.now()}`;
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local role "${APP}"`);
    await tx`insert into automation.applied (rule_code, dedupe_key, status) values ('rc7_probe', ${key}, 'PENDING') on conflict do nothing`;
    await tx`update automation.applied set status = 'DONE', attempts = attempts + 1, updated_dt = now() where rule_code = 'rc7_probe' and dedupe_key = ${key}`;
    await tx`insert into automation.decision_log (rule_code, dedupe_key, decision, reason) values ('rc7_probe', ${key}, 'NOOP', 'grant probe')`;
    await tx`insert into automation.dead_letter (rule_code, dedupe_key, error) values ('rc7_probe', ${key}, 'probe')`;
    const [row] = await tx`select status from automation.applied where rule_code = 'rc7_probe' and dedupe_key = ${key}`;
    assert.equal(row?.status, 'DONE');
    await tx`delete from automation.dead_letter where rule_code = 'rc7_probe' and dedupe_key = ${key}`;
    throw new Error('rollback'); // leave nothing behind
  }).catch((e: Error) => { if (e.message !== 'rollback') throw e; });
});

test('a table the owner adds to automation later is usable by the app role (default privileges)', async () => {
  await sql`create table automation.rc7_later (id int primary key, note text)`;
  try {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      const [r] = await sql`select has_table_privilege(${APP}, 'automation.rc7_later', ${priv}) as ok`;
      assert.equal(r?.ok, true, `${priv} on a later automation table`);
    }
  } finally {
    await sql`drop table automation.rc7_later`;
  }
});

test('idempotent: the block re-run as-is changes nothing and does not fail', async () => {
  const before = await sql`select relname, relacl::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'automation' order by 1`;
  await runBlock(APP);
  await runBlock(APP);
  const after = await sql`select relname, relacl::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'automation' order by 1`;
  assert.deepEqual(after, before);
});

test('unset DB_APP_ROLE grants nothing (dev/CI); a role that does not exist fails the migration', async () => {
  await runBlock(''); // NOTICE only
  const [usage] = await sql`select has_schema_privilege(${OTHER}, 'automation', 'USAGE') as ok`;
  assert.equal(usage?.ok, false);
  await assert.rejects(runBlock(`${BASE}_no_such_role`.slice(0, 63)), /is not a role in this cluster/);
});
