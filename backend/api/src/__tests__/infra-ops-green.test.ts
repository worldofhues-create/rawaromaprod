// OPS_GREEN §17 — static checks over infra/aws for the four RawProd ops defects this lane closed:
// the demo reset's CA bundle, env-render drift (production + demo), the deploy health-check
// redirect, and the live nginx additions recorded in the repo. Each assertion names the defect it
// pins, so a regression reads as the defect coming back rather than as a string mismatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** One `case` arm (`app)` / `vault)`) of a render script, up to its `;;`. */
const arm = (src: string, name: string) => {
  const i = src.indexOf(`\n${name})\n`);
  assert.ok(i >= 0, `no ${name}) arm`);
  return src.slice(i, src.indexOf('\n  ;;', i));
};
/** The body of the heredoc that renders `file`. */
const rendered = (src: string, file: string) => {
  const i = src.indexOf(`put ${file} <<X\n`);
  assert.ok(i >= 0, `nothing renders ${file}`);
  const start = i + `put ${file} <<X\n`.length;
  return src.slice(start, src.indexOf('\nX\n', start));
};
const keys = (body: string) => new Set(body.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0]));

test('every infra script touched here is valid bash', () => {
  for (const f of ['infra/aws/deploy.sh', 'infra/aws/env/render-env.sh', 'infra/aws/demo/render-demo-env.sh', 'infra/aws/demo/reset-demo.sh']) {
    execFileSync('bash', ['-n', join(ROOT, f)]);
  }
});

test('reset-demo: the create-demo-account step names the RDS CA bundle (ALEMBIC_DB_CA_FILE)', () => {
  const s = read('infra/aws/demo/reset-demo.sh');
  const step = s.slice(s.indexOf('log "demo account"'), s.lastIndexOf('create-demo-account.mjs'));
  assert.match(step, /ALEMBIC_DB_CA_FILE=\/etc\/alembic\/certs\/rds-global-bundle\.pem/);
});

test('render-env app: renders every key the production app box runs with', () => {
  const s = read('infra/aws/env/render-env.sh');
  const body = rendered(arm(s, 'app'), '/etc/rawprod/api.env');
  const k = keys(body);
  for (const key of ['ALEMBIC_ASSERTION_TENANT_ID', 'INTERNAL_BRIDGE_KEY', 'VAULT_API_INTERNAL_URL',
    'RUN_WORKER_IN_PROCESS', 'FORMULA_DATABASE_URL', 'FORMULA_KMS_KEY_ID', 'FORMULA_KMS_REGION',
    'RAWPROD_ASSERTION_EXPECTED_TARGETS', 'BRIDGE_HMAC_KEK', 'GIT_SHA', 'DATABASE_URL', 'JWT_SECRET',
    'ALEMBIC_ASSERTION_VERIFY_KEY', 'CORS_ORIGINS']) {
    assert.ok(k.has(key), `api.env lacks ${key}`);
  }
  assert.match(body, /^RAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform,vault$/m);
  assert.match(body, /^RUN_WORKER_IN_PROCESS=true$/m);
  assert.match(body, /^VAULT_API_INTERNAL_URL=http:\/\/\$VAULT_PRIVATE:4100$/m);
  // No vault password on the app box: user@host, never user:password@host.
  assert.match(body, /^FORMULA_DATABASE_URL=postgres:\/\/ra_vault@\$VAULT_PG\/vault\?sslmode=require$/m);
  assert.match(arm(s, 'app'), /KEK=\$\(g \/rawaroma\/rawprod\/bridge-hmac-kek\)/);
  assert.match(arm(s, 'app'), /IBK=\$\(g \/rawaroma\/bridge\/internal-bridge-key\)/);
});

test('render-env vault: VAULT_MODE, no DATABASE_URL, the rawvault CORS origin, audit key carried', () => {
  const s = read('infra/aws/env/render-env.sh');
  const body = rendered(arm(s, 'vault'), '/etc/rawprod/vault.env');
  const k = keys(body);
  assert.match(body, /^VAULT_MODE=true$/m);
  assert.equal(k.has('DATABASE_URL'), false, 'the vault box must not hold the main RawProd DATABASE_URL');
  assert.match(body, /^CORS_ORIGINS=https:\/\/rawvault\.huecycle\.in$/m);
  for (const key of ['INTERNAL_BRIDGE_KEY', 'ALEMBIC_ASSERTION_TENANT_ID', 'FORMULA_DATABASE_URL', 'GIT_SHA']) {
    assert.ok(k.has(key), `vault.env lacks ${key}`);
  }
  assert.match(body, /^\$AUDIT$/m, 'FORMULA_AUDIT_HMAC_WRAPPED must be carried, never dropped');
});

test('render-demo-env app: the demo RawProd API gets the keys it ran with from api.extra.env', () => {
  const s = read('infra/aws/demo/render-demo-env.sh');
  const a = arm(s, 'app');
  const body = rendered(a, '/etc/rawprod-demo/api.env');
  const k = keys(body);
  for (const key of ['ALEMBIC_ASSERTION_TENANT_ID', 'VAULT_API_INTERNAL_URL',
    'FORMULA_DATABASE_URL', 'BRIDGE_HMAC_KEK', 'GIT_SHA']) {
    assert.ok(k.has(key), `demo api.env lacks ${key}`);
  }
  assert.match(body, /^\$RP_KMS$/m, 'FORMULA_KMS_KEY_ID line');
  // Lane cfg-rp (live 2026-09-25): the demo runs WITHOUT the in-process worker, so the render carries
  // RUN_WORKER_IN_PROCESS from the box (\$RP_WORKER) instead of introducing it; infra-live-capture.test.ts runs it.
  assert.match(body, /^\$RP_WORKER$/m, 'RUN_WORKER_IN_PROCESS is carried, not introduced');
  assert.match(body, /^VAULT_API_INTERNAL_URL=http:\/\/\$VAULT_PRIVATE:4111$/m);
  assert.match(body, /^FORMULA_DATABASE_URL=postgres:\/\/vault_demo_app@\$VPG\/vault_demo\?sslmode=require$/m);
  assert.match(a, /rm -f "(\$E)?\$RP_EXTRA"/, 'the hand-placed api.extra.env is retired once its keys are rendered');
  assert.match(rendered(arm(s, 'vault'), '/etc/rawprod-demo/vault.env'), /^\$V_AUDIT$/m);
});

test('no render script prints a value', () => {
  for (const f of ['infra/aws/env/render-env.sh', 'infra/aws/demo/render-demo-env.sh']) {
    const code = read(f).split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(code, /echo[^\n]*\$\((g|carry|opt) /, `${f} echoes a fetched value`);
    assert.doesNotMatch(code, /set -x/, `${f} traces commands (would print values)`);
  }
});

test('deploy.sh: API checked directly, consoles over HTTPS with SNI+Host -- never the port-80 redirect', () => {
  const s = read('infra/aws/deploy.sh');
  const health = s.slice(s.indexOf('health() {'), s.indexOf('version() {'));
  assert.match(health, /http:\/\/127\.0\.0\.1:\$API_PORT\/health/);
  assert.match(s, /--resolve "\$1:443:127\.0\.0\.1" "https:\/\/\$1\/"/);
  assert.doesNotMatch(health, /-H 'Host: [^']+' http:\/\/127\.0\.0\.1\//, 'the old check got a 301 on every deploy');
  assert.doesNotMatch(s, /curl[^\n]* -k /, 'certificate verification stays on');
  // A passing health() is what writes DEPLOYED_SHA.
  assert.match(s, /if health; then[\s\S]*echo "\$full" > "\$STATE"/);
});

test('nginx: the live console-config / vault-config injection and the rawvault vhost are in the repo', () => {
  const hosts = read('infra/aws/nginx/huecycle-hosts.conf');
  assert.equal((hosts.match(/location = \/console-config\.js \{ root \/var\/www\/rawprod-config\/prod;/g) ?? []).length, 2);
  assert.equal((hosts.match(/location = \/console-config\.js \{ root \/var\/www\/rawprod-config\/demo;/g) ?? []).length, 2);
  assert.equal((hosts.match(/sub_filter '<script src="\/shell\.js">'/g) ?? []).length, 4);
  assert.match(hosts, /location ~ \^\/\(fonts\/\|logo\/\|/, 'the logo/ route');
  assert.match(read('infra/aws/nginx/rawprod-cf-origin.conf'), /location = \/console-config\.js/);

  const vault = read('infra/aws/nginx/rawvault.conf');
  assert.match(vault, /server_name rawvault\.huecycle\.in;/);
  assert.match(vault, /location \/main\/ \{[^}]*proxy_pass http:\/\/rawprod_api_cf\/;/);
  assert.match(vault, /location = \/vault-config\.js/);
  assert.match(vault, /sub_filter '<script src="\/vault\.js"><\/script>' '<script src="\/vault-config\.js"><\/script><script src="\/vault\.js"><\/script>';/);
  assert.match(vault, /upstream rawvault_api_private \{ server 172\.31\.51\.157:4100;/);
  for (const loc of vault.match(/location[^{]*\{[^}]*\}/g) ?? []) {
    if (/proxy_pass|try_files \/vault-config/.test(loc)) {
      assert.match(loc, /include \/etc\/nginx\/rawprod\/security-headers-vault\.conf;/, `rawvault.conf location without headers:\n${loc}`);
    }
  }

  for (const f of ['prod/console-config.js', 'demo/console-config.js', 'vault/vault-config.js']) {
    assert.ok(existsSync(join(ROOT, 'infra/aws/nginx/static-config', f)), f);
  }
  assert.match(read('infra/aws/nginx/static-config/vault/vault-config.js'), /window\.MAIN_API = '\/main';/);
  // Public files: nothing that looks like a credential.
  for (const f of ['prod/console-config.js', 'demo/console-config.js', 'vault/vault-config.js']) {
    assert.doesNotMatch(read(`infra/aws/nginx/static-config/${f}`), /secret|token|password|key\s*[:=]/i);
  }
});
