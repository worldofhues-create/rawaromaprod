/* Stand up RawProd for the rehearsal, as e2e/harness/up.mjs does, on scratch databases in a private PG17
 * (PostGIS). Usage: node rp-up.mjs <repoRoot> <runDir>
 *
 * STOCK-E2E-2: ports and names come from the environment (defaults: the first run's), and with
 * SE2E_RP_APP_ROLE set the databases are built AS PRODUCTION'S ARE: a schema owner that is not a superuser
 * runs every migration (DB_APP_ROLE named, so each migration's own grant block runs), and the two APIs
 * connect as a DML-only application role. A stand-up that runs everything as the laptop's superuser cannot
 * see a missing grant, and a missing grant is a 500 on the first request in production.
 *   SE2E_RP_PG_PORT, SE2E_RP_API_PORT, SE2E_RP_VAULT_PORT   ports (5561, 4361, 4362)
 *   SE2E_RP_DB                 main database name (stock_e2e_rp); the Vault's is <name>_vault
 *   SE2E_RP_OWNER, SE2E_RP_APP_ROLE   production-like roles (unset: everything as $USER, as before)
 *   ASSERT_TENANT              Alembic's tenant id, set on the API from the start (production sets it)
 *   SE2E_ALLOWED_HOSTS         extra host:port entries the bridge may deliver to (loopback only)
 * keys.json in the run directory is reused when it is already there, so Alembic and RawProd can be handed
 * the two halves of one key pair whichever starts first. */
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [ROOT, RUN] = process.argv.slice(2);
const E = process.env;
const PORTS = { pg: Number(E.SE2E_RP_PG_PORT || 5561), api: Number(E.SE2E_RP_API_PORT || 4361), vaultApi: Number(E.SE2E_RP_VAULT_PORT || 4362), alembic: Number(E.ALEMBIC_PORT || 4371) };
const MAIN_DB = E.SE2E_RP_DB || 'stock_e2e_rp', VAULT_DB = `${MAIN_DB}_vault`, DB_USER = E.USER;
const OWNER = E.SE2E_RP_OWNER || '', APP = E.SE2E_RP_APP_ROLE || '';
for (const n of [MAIN_DB, OWNER, APP]) if (n && !/^[a-z][a-z0-9_]*$/.test(n)) throw new Error(`not a plain identifier: ${n}`);
const PGBIN = '/opt/homebrew/opt/postgresql@17/bin';
const dbUrl = (n, user = DB_USER) => `postgres://${user}@127.0.0.1:${PORTS.pg}/${n}`;
const b64 = (n) => randomBytes(n).toString('base64');
mkdirSync(RUN, { recursive: true });
const pgdata = join(RUN, 'pg');
if (!existsSync(join(pgdata, 'PG_VERSION'))) {
  execFileSync(join(PGBIN, 'initdb'), ['-D', pgdata, '-A', 'trust', '-U', DB_USER, '-E', 'UTF8'], { stdio: 'ignore' });
}
try { execFileSync(join(PGBIN, 'pg_ctl'), ['-D', pgdata, 'status'], { stdio: 'ignore' }); } catch {
  execFileSync(join(PGBIN, 'pg_ctl'), ['-D', pgdata, '-w', '-l', join(RUN, 'pg.log'), '-o', `-p ${PORTS.pg} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`, 'start'], { stdio: 'ignore' });
}
const psql = (db, sql, user = DB_USER) => execFileSync(join(PGBIN, 'psql'), ['-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAtc', sql], { encoding: 'utf8' });
psql('postgres', `DROP DATABASE IF EXISTS ${MAIN_DB}`); psql('postgres', `DROP DATABASE IF EXISTS ${VAULT_DB}`);
if (OWNER && APP) {
  // The roles production has (infra/aws/PROVISIONED.md): an owner with no superuser and no bypass, and a DML role.
  for (const r of [OWNER, APP]) psql('postgres', `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
  for (const d of [MAIN_DB, VAULT_DB]) {
    psql('postgres', `CREATE DATABASE ${d} OWNER ${OWNER}`);
    psql('postgres', `REVOKE CONNECT ON DATABASE ${d} FROM PUBLIC; GRANT CONNECT ON DATABASE ${d} TO ${APP}`);
    // "created as master": an owner that is not a superuser cannot create these itself.
    for (const x of ['pgcrypto', 'citext', 'pg_trgm', 'postgis']) psql(d, `CREATE EXTENSION IF NOT EXISTS ${x}`);
    psql(d, `ALTER SCHEMA public OWNER TO ${OWNER}`);
  }
} else {
  psql('postgres', `CREATE DATABASE ${MAIN_DB}`); psql('postgres', `CREATE DATABASE ${VAULT_DB}`);
}
const keysFile = join(RUN, 'keys.json');
let signingKey, verifyKey;
if (existsSync(keysFile) && JSON.parse(readFileSync(keysFile, 'utf8')).verifyKey) ({ signingKey, verifyKey } = JSON.parse(readFileSync(keysFile, 'utf8')));
else {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  signingKey = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  verifyKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(keysFile, JSON.stringify({ signingKey, verifyKey }), { mode: 0o600 });
}
const ROLE_ENVS = ['OWNER', 'ADMIN', 'PROCUREMENT', 'RECEIVING', 'QC', 'WAREHOUSE', 'COMPOUNDING', 'PRODUCTION', 'FILLING', 'PACKAGING', 'SALES', 'FORMULATOR', 'VAULT_APPROVER', 'PLATFORM_ADMIN', 'PICKER', 'VERIFIER', 'MIXER', 'PACKING', 'LOGISTICS', 'FINANCE'];
const base = { ...process.env };
for (const k of ['DATABASE_URL', 'DATABASE_URL_APP', 'FORMULA_DATABASE_URL', 'NODE_OPTIONS']) delete base[k];
const migUser = OWNER || DB_USER, runUser = APP || DB_USER;
const dbEnv = { ...base, DATABASE_URL: dbUrl(MAIN_DB, migUser), FORMULA_DATABASE_URL: dbUrl(VAULT_DB, migUser), ...(APP ? { DB_APP_ROLE: APP } : {}) };
const log = openSync(join(RUN, 'provision.log'), 'w');
execFileSync('pnpm', ['db:migrate'], { cwd: ROOT, env: dbEnv, stdio: ['ignore', log, log] });
const seedEnv = { ...dbEnv, BOOTSTRAP_OWNER_EMAIL: 'owner@rawaroma.local' };
for (const r of ROLE_ENVS) seedEnv[`BOOTSTRAP_${r}_PASSWORD`] = b64(24);
execFileSync('pnpm', ['db:seed'], { cwd: ROOT, env: seedEnv, stdio: ['ignore', log, log] });
if (OWNER && APP) {
  // The repository's own statement of the application role's standing grants (the demo stack applies it after
  // every migrate): DML on what the owner owns, and no more. Run as the owner, as it is there.
  for (const d of [MAIN_DB, VAULT_DB]) {
    execFileSync(join(PGBIN, 'psql'), ['-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', OWNER, '-d', d, '-q', '-v', `app=${APP}`, '-v', 'skip=', '-f', join(ROOT, 'infra/aws/demo/sql/app-role-grants.sql')], { stdio: ['ignore', log, log] });
  }
}
const secrets = { JWT_SECRET: b64(48), FORMULA_KEK: b64(32), BRIDGE_HMAC_KEK: b64(32), INTERNAL_BRIDGE_KEY: b64(32) };
const allowed = [`127.0.0.1:${PORTS.alembic}`, ...(E.SE2E_ALLOWED_HOSTS ? E.SE2E_ALLOWED_HOSTS.split(',') : [])].join(',');
const common = { ...base, ...secrets, NODE_ENV: 'development', APP_ENV: 'dev', ALEMBIC_ASSERTION_VERIFY_KEY: verifyKey,
  ...(E.ASSERT_TENANT ? { ALEMBIC_ASSERTION_TENANT_ID: E.ASSERT_TENANT } : {}),
  OUTBOX_POLL_MS: '1000', BRIDGE_WEBHOOK_ALLOWED_HOSTS: allowed, AUTOMATION_POLL_MS: '1000', CONSUMPTION_POLL_MS: '1000',
  VAULT_API_INTERNAL_URL: `http://127.0.0.1:${PORTS.vaultApi}`, VAULT_CATALOGUE_SYNC_MS: '2000', VAULT_COMPLIANCE_SYNC_MS: '2000' };
const apiDir = join(ROOT, 'backend/api');
const reg = ['--import', '@swc-node/register/esm-register'];
function start(name, args, env) {
  const l = openSync(join(RUN, `${name}.log`), 'w');
  const child = spawn('node', args, { cwd: apiDir, env, stdio: ['ignore', l, l], detached: true });
  child.unref(); writeFileSync(join(RUN, `${name}.pid`), String(child.pid));
}
start('vault-api', [...reg, 'src/vault-main.ts'], { ...common, PORT: String(PORTS.vaultApi), VAULT_MODE: 'true', FORMULA_DATABASE_URL: dbUrl(VAULT_DB, runUser) });
start('api', [...reg, 'src/main.ts'], { ...common, PORT: String(PORTS.api), RUN_WORKER_IN_PROCESS: 'true', DATABASE_URL: dbUrl(MAIN_DB, runUser), FORMULA_DATABASE_URL: 'postgres://ra_vault@127.0.0.1:1/unreachable_from_main' });
for (const [u, l] of [[`http://127.0.0.1:${PORTS.api}/health`, 'api'], [`http://127.0.0.1:${PORTS.vaultApi}/health`, 'vault']]) {
  let ok = false;
  for (let i = 0; i < 180 && !ok; i++) { try { ok = (await fetch(u)).ok; } catch {} if (!ok) await new Promise((r) => setTimeout(r, 1000)); }
  if (!ok) throw new Error(`${l} not up; see ${RUN}`);
}
console.log('rawprod up', PORTS, OWNER && APP ? 'as production: owner and application role' : 'as the superuser');
