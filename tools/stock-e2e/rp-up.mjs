/* Stand up RawProd for the rehearsal, as e2e/harness/up.mjs does, on scratch databases
 * stock_e2e_rp and stock_e2e_rp_vault in a private PG17 (PostGIS). Usage: node rp-up.mjs <repoRoot> <runDir> */
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, openSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [ROOT, RUN] = process.argv.slice(2);
const PORTS = { pg: 5561, api: 4361, vaultApi: 4362, alembic: Number(process.env.ALEMBIC_PORT || 4371) };
const MAIN_DB = 'stock_e2e_rp', VAULT_DB = 'stock_e2e_rp_vault', DB_USER = process.env.USER;
const PGBIN = '/opt/homebrew/opt/postgresql@17/bin';
const dbUrl = (n) => `postgres://${DB_USER}@127.0.0.1:${PORTS.pg}/${n}`;
const b64 = (n) => randomBytes(n).toString('base64');
mkdirSync(RUN, { recursive: true });
const pgdata = join(RUN, 'pg');
if (!existsSync(join(pgdata, 'PG_VERSION'))) {
  execFileSync(join(PGBIN, 'initdb'), ['-D', pgdata, '-A', 'trust', '-U', DB_USER, '-E', 'UTF8'], { stdio: 'ignore' });
}
try { execFileSync(join(PGBIN, 'pg_ctl'), ['-D', pgdata, 'status'], { stdio: 'ignore' }); } catch {
  execFileSync(join(PGBIN, 'pg_ctl'), ['-D', pgdata, '-w', '-l', join(RUN, 'pg.log'), '-o', `-p ${PORTS.pg} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`, 'start'], { stdio: 'ignore' });
}
const psql = (db, sql) => execFileSync(join(PGBIN, 'psql'), ['-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', DB_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAtc', sql], { encoding: 'utf8' });
psql('postgres', `DROP DATABASE IF EXISTS ${MAIN_DB}`); psql('postgres', `DROP DATABASE IF EXISTS ${VAULT_DB}`);
psql('postgres', `CREATE DATABASE ${MAIN_DB}`); psql('postgres', `CREATE DATABASE ${VAULT_DB}`);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const signingKey = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const verifyKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const ROLE_ENVS = ['OWNER', 'ADMIN', 'PROCUREMENT', 'RECEIVING', 'QC', 'WAREHOUSE', 'COMPOUNDING', 'PRODUCTION', 'FILLING', 'PACKAGING', 'SALES', 'FORMULATOR', 'VAULT_APPROVER', 'PLATFORM_ADMIN', 'PICKER', 'VERIFIER', 'MIXER', 'PACKING', 'LOGISTICS', 'FINANCE'];
const base = { ...process.env };
for (const k of ['DATABASE_URL', 'DATABASE_URL_APP', 'FORMULA_DATABASE_URL', 'NODE_OPTIONS']) delete base[k];
const dbEnv = { ...base, DATABASE_URL: dbUrl(MAIN_DB), FORMULA_DATABASE_URL: dbUrl(VAULT_DB) };
const log = openSync(join(RUN, 'provision.log'), 'w');
execFileSync('pnpm', ['db:migrate'], { cwd: ROOT, env: dbEnv, stdio: ['ignore', log, log] });
const seedEnv = { ...dbEnv, BOOTSTRAP_OWNER_EMAIL: 'owner@rawaroma.local' };
for (const r of ROLE_ENVS) seedEnv[`BOOTSTRAP_${r}_PASSWORD`] = b64(24);
execFileSync('pnpm', ['db:seed'], { cwd: ROOT, env: seedEnv, stdio: ['ignore', log, log] });
const secrets = { JWT_SECRET: b64(48), FORMULA_KEK: b64(32), BRIDGE_HMAC_KEK: b64(32), INTERNAL_BRIDGE_KEY: b64(32) };
const common = { ...base, ...secrets, NODE_ENV: 'development', APP_ENV: 'dev', ALEMBIC_ASSERTION_VERIFY_KEY: verifyKey,
  OUTBOX_POLL_MS: '1000', BRIDGE_WEBHOOK_ALLOWED_HOSTS: `127.0.0.1:${PORTS.alembic}`, AUTOMATION_POLL_MS: '1000', CONSUMPTION_POLL_MS: '1000',
  VAULT_API_INTERNAL_URL: `http://127.0.0.1:${PORTS.vaultApi}`, VAULT_CATALOGUE_SYNC_MS: '2000', VAULT_COMPLIANCE_SYNC_MS: '2000' };
const apiDir = join(ROOT, 'backend/api');
const reg = ['--import', '@swc-node/register/esm-register'];
function start(name, args, env) {
  const l = openSync(join(RUN, `${name}.log`), 'w');
  const child = spawn('node', args, { cwd: apiDir, env, stdio: ['ignore', l, l], detached: true });
  child.unref(); writeFileSync(join(RUN, `${name}.pid`), String(child.pid));
}
start('vault-api', [...reg, 'src/vault-main.ts'], { ...common, PORT: String(PORTS.vaultApi), VAULT_MODE: 'true', FORMULA_DATABASE_URL: dbUrl(VAULT_DB) });
start('api', [...reg, 'src/main.ts'], { ...common, PORT: String(PORTS.api), RUN_WORKER_IN_PROCESS: 'true', DATABASE_URL: dbUrl(MAIN_DB), FORMULA_DATABASE_URL: 'postgres://ra_vault@127.0.0.1:1/unreachable_from_main' });
writeFileSync(join(RUN, 'keys.json'), JSON.stringify({ signingKey }), { mode: 0o600 });
for (const [u, l] of [[`http://127.0.0.1:${PORTS.api}/health`, 'api'], [`http://127.0.0.1:${PORTS.vaultApi}/health`, 'vault']]) {
  let ok = false;
  for (let i = 0; i < 180 && !ok; i++) { try { ok = (await fetch(u)).ok; } catch {} if (!ok) await new Promise((r) => setTimeout(r, 1000)); }
  if (!ok) throw new Error(`${l} not up; see ${RUN}`);
}
console.log('rawprod up', PORTS);
