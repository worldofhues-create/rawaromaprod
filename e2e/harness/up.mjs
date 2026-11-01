/* Stand up the real stack: Postgres with PostGIS, the real migrations, the RBAC seed and one login per
 * role (never demo data), the real main API and the real Vault API as separate processes.
 *
 *   node e2e/harness/up.mjs        (pnpm e2e:up)      fresh databases every time
 *   node e2e/harness/down.mjs      (pnpm e2e:down)
 *
 * Why a private Postgres: migration 0000 needs PostGIS, and the machine's shared server does not have
 * it. BS_PG_EXTERNAL=1 uses a server that is already up (CI's service container). Why fresh: each walk
 * asserts a row it made; a database carried over could make that pass on an old row.
 *
 * The keys are generated here, per run, into e2e/.run (git-ignored, mode 600), and never printed. */
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_USER, MAIN_DB, PORTS, ROOT, RUN, VAULT_DB, dbUrl } from './config.mjs';

const b64 = (n) => randomBytes(n).toString('base64');
const external = process.env.BS_PG_EXTERNAL === '1';
const PGBIN = process.env.BS_PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const pgdata = join(RUN, 'pg');
mkdirSync(RUN, { recursive: true });
rmSync(join(RUN, 'chain.json'), { force: true }); // what the chain built belongs to the databases dropped below

async function waitFor(url, label, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not answer at ${url} within ${seconds}s; see e2e/.run/*.log`);
}
function start(name, cmd, args, cwd, env) {
  const log = openSync(join(RUN, `${name}.log`), 'w');
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', log, log], detached: true });
  child.unref();
  writeFileSync(join(RUN, `${name}.pid`), String(child.pid));
}

for (const f of ['api', 'vault-api', 'consoles']) {
  if (existsSync(join(RUN, `${f}.pid`))) throw new Error(`e2e/.run/${f}.pid exists: run pnpm e2e:down first`);
}

const psql = (db, sql) => external
  ? execFileSync('psql', [dbUrl(db), '-v', 'ON_ERROR_STOP=1', '-qAtc', sql], { encoding: 'utf8' })
  : execFileSync(join(PGBIN, 'psql'), ['-h', '127.0.0.1', '-p', String(PORTS.pg), '-U', DB_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAtc', sql], { encoding: 'utf8' });

if (!external) {
  rmSync(pgdata, { recursive: true, force: true });
  execFileSync(join(PGBIN, 'initdb'), ['-D', pgdata, '-A', 'trust', '-U', DB_USER, '-E', 'UTF8'], { stdio: 'ignore' });
  execFileSync(join(PGBIN, 'pg_ctl'), ['-D', pgdata, '-w', '-l', join(RUN, 'pg.log'),
    '-o', `-p ${PORTS.pg} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${RUN} -c fsync=off`, 'start'], { stdio: 'ignore' });
}
psql('postgres', `DROP DATABASE IF EXISTS ${MAIN_DB}`);
psql('postgres', `DROP DATABASE IF EXISTS ${VAULT_DB}`);
psql('postgres', `CREATE DATABASE ${MAIN_DB}`);
psql('postgres', `CREATE DATABASE ${VAULT_DB}`);

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const signingKey = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const verifyKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const ROLE_ENVS = ['OWNER', 'ADMIN', 'PROCUREMENT', 'RECEIVING', 'QC', 'WAREHOUSE', 'COMPOUNDING', 'PRODUCTION', 'FILLING', 'PACKAGING', 'SALES', 'FORMULATOR', 'VAULT_APPROVER', 'PLATFORM_ADMIN'];

const base = { ...process.env };
for (const k of ['DATABASE_URL', 'DATABASE_URL_APP', 'FORMULA_DATABASE_URL', 'NODE_OPTIONS']) delete base[k];
const dbEnv = { ...base, DATABASE_URL: dbUrl(MAIN_DB), FORMULA_DATABASE_URL: dbUrl(VAULT_DB) };
const quiet = { cwd: ROOT, stdio: ['ignore', openSync(join(RUN, 'provision.log'), 'w'), openSync(join(RUN, 'provision.log'), 'a')] };
execFileSync('pnpm', ['db:migrate'], { ...quiet, env: dbEnv });
const seedEnv = { ...dbEnv, BOOTSTRAP_OWNER_EMAIL: 'owner@rawaroma.local' };
for (const r of ROLE_ENVS) seedEnv[`BOOTSTRAP_${r}_PASSWORD`] = b64(24); // the seed needs one to make the login; nobody signs in with it
execFileSync('pnpm', ['db:seed'], { ...quiet, env: seedEnv });

const secrets = { JWT_SECRET: b64(48), FORMULA_KEK: b64(32), BRIDGE_HMAC_KEK: b64(32), INTERNAL_BRIDGE_KEY: b64(32) };
const common = {
  ...base, ...secrets, NODE_ENV: 'development', APP_ENV: 'dev', ALEMBIC_ASSERTION_VERIFY_KEY: verifyKey,
  OUTBOX_POLL_MS: '1000', BRIDGE_WEBHOOK_ALLOWED_HOSTS: `127.0.0.1:${PORTS.deadPeer}`, AUTOMATION_POLL_MS: '1000', CONSUMPTION_POLL_MS: '1000', VAULT_API_INTERNAL_URL: `http://127.0.0.1:${PORTS.vaultApi}`, VAULT_CATALOGUE_SYNC_MS: '2000', VAULT_COMPLIANCE_SYNC_MS: '2000',
};
const apiDir = join(ROOT, 'backend/api');
const reg = ['--import', '@swc-node/register/esm-register'];
start('vault-api', 'node', [...reg, 'src/vault-main.ts'], apiDir, { ...common, PORT: String(PORTS.vaultApi), VAULT_MODE: 'true', FORMULA_DATABASE_URL: dbUrl(VAULT_DB) });
// As production: the main box has no route to the formula database.
start('api', 'node', [...reg, 'src/main.ts'], apiDir, { ...common, PORT: String(PORTS.api), RUN_WORKER_IN_PROCESS: 'true', DATABASE_URL: dbUrl(MAIN_DB), FORMULA_DATABASE_URL: 'postgres://ra_vault@127.0.0.1:1/unreachable_from_main' });
start('consoles', 'node', [join(ROOT, 'e2e/harness/consoles.mjs')], ROOT, base);
writeFileSync(join(RUN, 'keys.json'), JSON.stringify({ signingKey }), { mode: 0o600 });

await waitFor(`http://127.0.0.1:${PORTS.api}/health`, 'main API');
await waitFor(`http://127.0.0.1:${PORTS.vaultApi}/health`, 'Vault API');
await waitFor(`http://127.0.0.1:${PORTS.factory}/`, 'consoles');
console.log(`stack up: factory :${PORTS.factory} platform :${PORTS.platform} vault :${PORTS.vault} api :${PORTS.api} vault-api :${PORTS.vaultApi} pg :${PORTS.pg} (${MAIN_DB}, ${VAULT_DB})`);
