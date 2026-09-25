// Lane cfg-rp — live-only server config captured into the repo (read-only SSM, 2026-09-25), so the next
// deploy can re-render env files and nginx without wiping the fixes that were only on the boxes.
//
// The render scripts are RUN here, against a sandbox (RENDER_ROOT) with `aws` stubbed on PATH, and the
// rendered files are compared with the key sets and public values read from the live boxes. Secrets are
// placeholders; what is asserted about them is which SSM parameter (or carried value) they came from.
// The nginx half is a static `nginx -t`-style pass over the vhosts enabled on the app box: braces, one
// definition per upstream / zone / map, every reference and include resolvable, one server per name+port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ── a sandbox box: files under RENDER_ROOT, SSM served by a stub `aws` ─────────────────────────────
type Box = { root: string; files: Record<string, string>; params: Record<string, string> };
function box(files: Record<string, string>, params: Record<string, string>): Box {
  const root = mkdtempSync(join(tmpdir(), 'rp-live-capture-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  mkdirSync(join(root, '.ssm')); mkdirSync(join(root, '.bin'));
  for (const [name, value] of Object.entries(params)) writeFileSync(join(root, '.ssm', name.replaceAll('/', '__')), value);
  writeFileSync(join(root, '.bin/aws'), `#!/usr/bin/env bash
name=""; q=""
while [ $# -gt 0 ]; do case "$1" in --name) name=$2; shift;; --query) q=$2; shift;; esac; shift; done
f="${root}/.ssm/$(printf '%s' "$name" | sed 's#/#__#g')"
[ -f "$f" ] || { echo "An error occurred (ParameterNotFound)" >&2; exit 254; }
if [ "$q" = Parameter.Name ]; then echo "$name"; else cat "$f"; echo; fi
`);
  chmodSync(join(root, '.bin/aws'), 0o755);
  return { root, files, params };
}
function run(b: Box, script: string, ...args: string[]) {
  return spawnSync('bash', [join(ROOT, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, RENDER_ROOT: b.root, PATH: `${join(b.root, '.bin')}:${process.env.PATH}` },
  });
}
const envOf = (b: Box, p: string) => {
  const out = new Map<string, string>();
  for (const l of readFileSync(join(b.root, p), 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l);
    if (m) out.set(m[1] as string, m[2] as string); // both groups always participate in a match
  }
  return out;
};
const sameSet = (actual: Iterable<string>, expected: string[], what: string) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${what}: key set differs from live`);
const noSecretPrinted = (r: { stdout: string; stderr: string }, b: Box) => {
  for (const v of Object.values(b.params)) {
    if (v.startsWith('https://') || v.startsWith('alias/')) continue; // public
    assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), 'a parameter value reached the output');
  }
};

// Placeholder values; the demo KEK deliberately DIFFERS from the production one, as it does live.
const DEMO_PARAMS: Record<string, string> = {
  '/rawaroma/demo/alembic-url': 'https://agw.execute-api.invalid',
  '/rawaroma/demo/factory-url': 'https://fgw.execute-api.invalid',
  '/rawaroma/demo/alembic/DB_PASSWORD_app': 'a-app-pw/+=',
  '/rawaroma/demo/alembic/DB_PASSWORD_owner': 'a-owner-pw',
  '/rawaroma/demo/alembic/SECRET_KEYS': 'v1:demo-secret-keys',
  '/rawaroma/demo/alembic/rawprod-assertion-signing-key': 'demo-signing-key-0123456789',
  '/rawaroma/demo/rawprod/DB_PASSWORD_app': 'rp-app-pw',
  '/rawaroma/demo/rawprod/DB_PASSWORD_owner': 'rp-owner-pw',
  '/rawaroma/demo/rawprod/JWT_SECRET': 'demo-jwt-secret-0123456789',
  '/rawaroma/demo/rawprod/assertion-verify-key': 'demo-verify-key-0123456789',
  '/rawaroma/demo/rawprod/bridge-hmac-kek': 'DEMO-KEK-never-run-live-0123',
  '/rawaroma/demo/rawprod/internal-bridge-key': 'demo-ibk-0123456789abcdef0123456789',
  '/rawaroma/rawprod/bridge-hmac-kek': 'PROD-KEK-the-demo-runs-with-01',
  '/rawaroma/demo/vault/FORMULA_KMS_KEY_ID': '034c5485-02cb-4aad-b944-ff08a9b33f1e',
  '/rawaroma/demo/vault/DB_PASSWORD_app': 'v-app-pw',
  '/rawaroma/demo/vault/DB_PASSWORD_owner': 'v-owner-pw',
};
const TENANT = '00000000-0000-7000-8000-0000000de770';
// The app box as read live: api.env without the vault wiring, which sits in the hand-placed api.extra.env.
const demoAppBox = (apiExtra = '', extraOverride?: string) => box({
  'etc/alembic-demo/tenant-id': TENANT + '\n',
  'etc/rawprod-demo/api.env': `NODE_ENV=production\nAPP_ENV=prod\nRAWPROD_ASSERTION_EXPECTED_TARGETS=factory,platform,vault\n${apiExtra}`,
  'etc/rawprod-demo/api.extra.env': extraOverride ??
    `FORMULA_KMS_KEY_ID=034c5485-02cb-4aad-b944-ff08a9b33f1e\nBRIDGE_HMAC_KEK=${DEMO_PARAMS['/rawaroma/rawprod/bridge-hmac-kek']}\nGIT_SHA=27db65039baf3de44d017167caf4b59fafd778f4\nALEMBIC_ASSERTION_TENANT_ID=${TENANT}\n`,
}, DEMO_PARAMS);

// Key sets read from the live boxes (key NAMES; the rawprod-demo set is the running process's environment).
// RC7 retires FORMULA_DATABASE_URL / FORMULA_KMS_KEY_ID / FORMULA_KMS_REGION from both APP boxes' api.env (the main
// API never composes FormulaModule since RC6's vault port, so nothing there reads them); both vault boxes keep them.
const FORMULA_KEYS = ['FORMULA_DATABASE_URL', 'FORMULA_KMS_KEY_ID', 'FORMULA_KMS_REGION'];
const LIVE = {
  alembicDemoApi: ['ALEMBIC_ENVIRONMENT', 'DATABASE_URL_APP', 'ALEMBIC_TENANT_ID', 'NODE_EXTRA_CA_CERTS', 'ALEMBIC_DB_CA_FILE',
    'ALEMBIC_PUBLIC_WEB_ORIGIN', 'ALEMBIC_CORS_ORIGINS', 'ALEMBIC_BEDROCK_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_SDK_LOAD_CONFIG', 'AWS_EC2_METADATA_DISABLED', 'ALEMBIC_SECRET_KEYS', 'ALEMBIC_RAWPROD_ASSERTION_SIGNING_KEY',
    'ALEMBIC_JANITOR_MS', 'ALEMBIC_LOOPS_MS', 'ALEMBIC_PUBLIC_ORIGIN', 'ALEMBIC_BRIDGE_SWEEP_MS', 'ALEMBIC_STAFF_MAIL_DROP',
    'ALEMBIC_ACCOUNT_MAIL_DROP', 'ALEMBIC_REF_PREFIX'],
  rawprodDemoApi: ['ALEMBIC_ASSERTION_AUDIENCE', 'ALEMBIC_ASSERTION_ISSUER', 'ALEMBIC_ASSERTION_TENANT_ID',
    'ALEMBIC_ASSERTION_VERIFY_KEY', 'APP_ENV', 'AWS_EC2_METADATA_DISABLED', 'BRIDGE_HMAC_KEK', 'CORS_ORIGINS', 'DATABASE_URL',
    'GIT_SHA', 'JWT_ACCESS_TTL', 'JWT_SECRET', 'NODE_ENV',
    'PGSSLROOTCERT', 'PORT', 'RAWPROD_ASSERTION_EXPECTED_TARGETS', 'RAWPROD_ENVIRONMENT', 'VAULT_API_INTERNAL_URL',
    'RUN_WORKER_IN_PROCESS'],
  rawprodDemoVault: ['NODE_ENV', 'APP_ENV', 'RAWPROD_ENVIRONMENT', 'JWT_ACCESS_TTL', 'PORT', 'VAULT_MODE', 'PGSSLROOTCERT',
    'FORMULA_DATABASE_URL', 'FORMULA_KMS_KEY_ID', 'FORMULA_KMS_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_SDK_LOAD_CONFIG', 'AWS_EC2_METADATA_DISABLED', 'JWT_SECRET', 'ALEMBIC_ASSERTION_ISSUER', 'ALEMBIC_ASSERTION_AUDIENCE',
    'ALEMBIC_ASSERTION_VERIFY_KEY', 'RAWPROD_ASSERTION_EXPECTED_TARGETS', 'CORS_ORIGINS', 'FORMULA_AUDIT_HMAC_WRAPPED'],
  rawprodApi: ['NODE_ENV', 'APP_ENV', 'PORT', 'PGSSLROOTCERT', 'ALEMBIC_ASSERTION_ISSUER', 'ALEMBIC_ASSERTION_AUDIENCE',
    'DATABASE_URL', 'JWT_SECRET', 'ALEMBIC_ASSERTION_VERIFY_KEY', 'RAWPROD_ASSERTION_EXPECTED_TARGETS',
    'ALEMBIC_ASSERTION_TENANT_ID', 'INTERNAL_BRIDGE_KEY', 'VAULT_API_INTERNAL_URL', 'RUN_WORKER_IN_PROCESS', 'CORS_ORIGINS',
    'BRIDGE_HMAC_KEK', 'GIT_SHA'],
  rawprodVault: ['NODE_ENV', 'APP_ENV', 'PORT', 'PGSSLROOTCERT', 'ALEMBIC_ASSERTION_ISSUER', 'ALEMBIC_ASSERTION_AUDIENCE',
    'VAULT_MODE', 'FORMULA_DATABASE_URL', 'FORMULA_KMS_KEY_ID', 'FORMULA_KMS_REGION', 'JWT_SECRET',
    'ALEMBIC_ASSERTION_VERIFY_KEY', 'RAWPROD_ASSERTION_EXPECTED_TARGETS', 'ALEMBIC_ASSERTION_TENANT_ID',
    'INTERNAL_BRIDGE_KEY', 'CORS_ORIGINS', 'GIT_SHA'],
};

test('render-demo-env app: ALEMBIC demo api.env is the live one -- 4 demo origins + API GW, public origin, sweep, mail drops', () => {
  const b = demoAppBox();
  try {
    const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'app');
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(b, 'etc/alembic-demo/api.env');
    sameSet(e.keys(), LIVE.alembicDemoApi, '/etc/alembic-demo/api.env');
    assert.equal(e.get('ALEMBIC_CORS_ORIGINS'), 'https://rawdemo.huecycle.in,https://rawdemoadmin.huecycle.in,' +
      'https://rawdemoagent.huecycle.in,https://rawdemostudio.huecycle.in,https://agw.execute-api.invalid');
    assert.equal(e.get('ALEMBIC_PUBLIC_WEB_ORIGIN'), 'https://agw.execute-api.invalid');
    assert.equal(e.get('ALEMBIC_PUBLIC_ORIGIN'), 'https://rawdemo.huecycle.in');
    assert.equal(e.get('ALEMBIC_BRIDGE_SWEEP_MS'), '60000');
    assert.equal(e.get('ALEMBIC_STAFF_MAIL_DROP'), '/srv/alembic-demo/var/maildrop');
    assert.equal(e.get('ALEMBIC_ACCOUNT_MAIL_DROP'), '/srv/alembic-demo/var/account-maildrop');
    assert.equal(e.get('ALEMBIC_TENANT_ID'), TENANT);
    assert.equal(e.get('ALEMBIC_RAWPROD_ASSERTION_SIGNING_KEY'), DEMO_PARAMS['/rawaroma/demo/alembic/rawprod-assertion-signing-key']);
    assert.match(e.get('DATABASE_URL_APP') ?? '', /^postgres:\/\/alembic_demo_app:a-app-pw%2F%2B%3D@/, 'password url-encoded');
    noSecretPrinted(r, b);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env app: the ALEMBIC demo api.env carries ALEMBIC_REF_PREFIX=DEMO, never production\'s RAC', () => {
  // Set live 2026-09-25. ALEMBIC reads it at boot; without it the demo's NEFT proforma rail is OFF and
  // POST /orders/:number/proforma refuses. DEMO, so a demo payment reference can never be mistaken for a
  // production one (RAC, rendered by the alembic repo's ops/deploy/render-env.sh).
  const b = demoAppBox();
  try {
    const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'app');
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(b.root, 'etc/alembic-demo/api.env'), 'utf8');
    assert.equal(envOf(b, 'etc/alembic-demo/api.env').get('ALEMBIC_REF_PREFIX'), 'DEMO');
    assert.equal(text.split('\n').filter((l) => l.startsWith('ALEMBIC_REF_PREFIX=')).length, 1);
    assert.doesNotMatch(text, /^ALEMBIC_REF_PREFIX=RAC$/m);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env app: web-build.env carries the three demo console origins, vault included, 0644', () => {
  const b = demoAppBox();
  try {
    assert.equal(run(b, 'infra/aws/demo/render-demo-env.sh', 'app').status, 0);
    const f = join(b.root, 'etc/alembic-demo/web-build.env');
    assert.deepEqual(readFileSync(f, 'utf8').trim().split('\n'), [
      'NEXT_PUBLIC_RAWPROD_FACTORY_ORIGIN=https://rawdemofactory.huecycle.in',
      'NEXT_PUBLIC_RAWPROD_PLATFORM_ORIGIN=https://rawdemoplatform.huecycle.in',
      'NEXT_PUBLIC_RAWPROD_VAULT_ORIGIN=https://rawdemovault.huecycle.in',
    ]);
    assert.equal(statSync(f).mode & 0o777, 0o644);
    assert.equal(statSync(join(b.root, 'etc/alembic-demo/api.env')).mode & 0o777, 0o600);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env app: rawprod-demo api.env is the running key set, targets incl. vault, KEK the one it RUNS with', () => {
  const b = demoAppBox();
  try {
    const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'app');
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(b, 'etc/rawprod-demo/api.env');
    sameSet(e.keys(), LIVE.rawprodDemoApi, '/etc/rawprod-demo/api.env');
    assert.equal(e.get('RAWPROD_ASSERTION_EXPECTED_TARGETS'), 'factory,platform,vault');
    // /rawaroma/demo/rawprod/bridge-hmac-kek exists and differs; switching would orphan every sealed bridge secret.
    assert.equal(e.get('BRIDGE_HMAC_KEK'), DEMO_PARAMS['/rawaroma/rawprod/bridge-hmac-kek']);
    // RC6: set live by P0 2026-09-25 -- without the in-process worker the demo's bridge outbox never drains (201 events
    // were stuck; the RawProd->ALEMBIC projection and every worker automation were dead). Rendered even when the box's
    // current file lacks it, as this sandbox's does.
    assert.equal(e.get('RUN_WORKER_IN_PROCESS'), 'true', 'the demo app must run the in-process worker');
    assert.equal(e.has('INTERNAL_BRIDGE_KEY'), false, 'the demo (and the demo vault) run without an internal bridge key');
    assert.equal(e.get('CORS_ORIGINS'), 'https://fgw.execute-api.invalid');
    assert.equal(e.get('ALEMBIC_ASSERTION_TENANT_ID'), TENANT);
    // RC7: the box's api.extra.env still holds FORMULA_KMS_KEY_ID; the render drops it (and every FORMULA_* key).
    for (const k of FORMULA_KEYS) assert.equal(e.has(k), false, `the demo app box must not carry ${k}`);
    assert.equal(e.get('VAULT_API_INTERNAL_URL'), 'http://172.31.51.157:4111');
    assert.equal(e.get('GIT_SHA'), '27db65039baf3de44d017167caf4b59fafd778f4');
    assert.equal(existsSync(join(b.root, 'etc/rawprod-demo/api.extra.env')), false, 'api.extra.env retired');
    noSecretPrinted(r, b);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env app: RUN_WORKER_IN_PROCESS=true is rendered whatever the box says, exactly once', () => {
  for (const onBox of ['', 'RUN_WORKER_IN_PROCESS=false\n', 'RUN_WORKER_IN_PROCESS=true\n']) {
    const b = demoAppBox(onBox);
    try {
      const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'app');
      assert.equal(r.status, 0, r.stderr);
      const text = readFileSync(join(b.root, 'etc/rawprod-demo/api.env'), 'utf8');
      assert.deepEqual(text.split('\n').filter((l) => l.startsWith('RUN_WORKER_IN_PROCESS=')), ['RUN_WORKER_IN_PROCESS=true'],
        `box had ${JSON.stringify(onBox)}`);
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  }
});

test('render-demo-env app: owner switches made on the box survive a re-render (demo KEK, worker, bridge key)', () => {
  const b = demoAppBox(
    `BRIDGE_HMAC_KEK=${DEMO_PARAMS['/rawaroma/demo/rawprod/bridge-hmac-kek']}\nRUN_WORKER_IN_PROCESS=true\nINTERNAL_BRIDGE_KEY=hand-set\n`, '');
  try {
    const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'app');
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(b, 'etc/rawprod-demo/api.env');
    assert.equal(e.get('BRIDGE_HMAC_KEK'), DEMO_PARAMS['/rawaroma/demo/rawprod/bridge-hmac-kek']);
    assert.equal(e.get('RUN_WORKER_IN_PROCESS'), 'true');
    assert.equal(e.get('INTERNAL_BRIDGE_KEY'), DEMO_PARAMS['/rawaroma/demo/rawprod/internal-bridge-key'], 'from SSM once switched on');
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env app: a KEK on the box that matches neither parameter is refused, not replaced', () => {
  const b = demoAppBox('BRIDGE_HMAC_KEK=some-third-kek\n', '');
  try {
    const before = readFileSync(join(b.root, 'etc/rawprod-demo/api.env'), 'utf8');
    const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'app');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /matches neither parameter/);
    assert.equal(readFileSync(join(b.root, 'etc/rawprod-demo/api.env'), 'utf8'), before);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env app: an unreadable secret stops the render before any file is written', () => {
  const { ['/rawaroma/demo/alembic/SECRET_KEYS']: _gone, ...params } = DEMO_PARAMS;
  const b = box({ 'etc/alembic-demo/tenant-id': TENANT }, params);
  try {
    const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'app');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SECRET_KEYS is empty; refusing/);
    assert.equal(existsSync(join(b.root, 'etc/alembic-demo/api.env')), false);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env app: an existing env directory keeps its mode (0711 lets the demo user reach aws/)', () => {
  const b = demoAppBox();
  try {
    chmodSync(join(b.root, 'etc/alembic-demo'), 0o711);
    assert.equal(run(b, 'infra/aws/demo/render-demo-env.sh', 'app').status, 0);
    assert.equal(statSync(join(b.root, 'etc/alembic-demo')).mode & 0o777, 0o711);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env vault: CORS admits rawdemovault, audit key carried, the live key set', () => {
  const b = box({ 'etc/rawprod-demo/vault.env': 'FORMULA_AUDIT_HMAC_WRAPPED=wrapped-audit-key\n' }, DEMO_PARAMS);
  try {
    const r = run(b, 'infra/aws/demo/render-demo-env.sh', 'vault');
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(b, 'etc/rawprod-demo/vault.env');
    sameSet(e.keys(), LIVE.rawprodDemoVault, '/etc/rawprod-demo/vault.env');
    assert.equal(e.get('CORS_ORIGINS'), 'https://fgw.execute-api.invalid,https://rawdemovault.huecycle.in');
    assert.equal(e.get('FORMULA_AUDIT_HMAC_WRAPPED'), 'wrapped-audit-key');
    assert.equal(e.get('RAWPROD_ASSERTION_EXPECTED_TARGETS'), 'vault');
    noSecretPrinted(r, b);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-demo-env vault: a hand-set INTERNAL_BRIDGE_KEY (owner switch) survives a re-render; none is introduced otherwise', () => {
  // Lane fread-rp: every main -> vault read on the demo (pick list, dashboard labels, the material
  // picker's catalogue push) needs the key on BOTH demo boxes; the vault render used to drop it.
  const on = box({ 'etc/rawprod-demo/vault.env': 'FORMULA_AUDIT_HMAC_WRAPPED=wrapped-audit-key\nINTERNAL_BRIDGE_KEY=hand-set\n' }, DEMO_PARAMS);
  try {
    const r = run(on, 'infra/aws/demo/render-demo-env.sh', 'vault');
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(on, 'etc/rawprod-demo/vault.env');
    assert.equal(e.get('INTERNAL_BRIDGE_KEY'), DEMO_PARAMS['/rawaroma/demo/rawprod/internal-bridge-key'], 'from SSM once switched on');
    sameSet(e.keys(), [...LIVE.rawprodDemoVault, 'INTERNAL_BRIDGE_KEY'], '/etc/rawprod-demo/vault.env (switched on)');
    noSecretPrinted(r, on);
  } finally { rmSync(on.root, { recursive: true, force: true }); }
  const off = box({}, DEMO_PARAMS);
  try {
    assert.equal(run(off, 'infra/aws/demo/render-demo-env.sh', 'vault').status, 0);
    assert.equal(envOf(off, 'etc/rawprod-demo/vault.env').has('INTERNAL_BRIDGE_KEY'), false, 'never introduced by a render');
  } finally { rmSync(off.root, { recursive: true, force: true }); }
});

const PROD_PARAMS: Record<string, string> = {
  '/rawaroma/bridge/internal-bridge-key': 'prod-ibk-0123456789abcdef0123456789abcdef',
  '/rawaroma/rawprod/ALEMBIC_ASSERTION_TENANT_ID': '00000000-0000-7000-8000-00000000c0de',
  '/rawaroma/rawprod/bridge-hmac-kek': 'PROD-KEK-0123456789',
  '/rawaroma/rawprod/DATABASE_URL': 'postgres://rawprod_app:pw@db.invalid/rawprod',
  '/rawaroma/rawprod/JWT_SECRET': 'prod-jwt-0123456789',
  '/rawaroma/rawprod/assertion-verify-key': 'prod-verify-0123456789',
  '/rawaroma/rawprod/MIGRATE_DATABASE_URL': 'postgres://rawprod_owner:pw@db.invalid/rawprod',
  // Readable by the app role, and the key ARN rather than the alias the app box runs with.
  '/rawaroma/vault/FORMULA_KMS_KEY_ID': 'arn:aws:kms:us-west-2:859485559854:key/83c66cf8-c125-4574-a889-584ecedf154c',
  '/rawaroma/vault/FORMULA_DATABASE_URL': 'postgres://ra_vault:pw@vault.invalid/vault',
  '/rawaroma/vault/MIGRATE_FORMULA_DATABASE_URL': 'postgres://ra_vault_owner:pw@vault.invalid/vault',
};

test('render-env app: the live production key set; targets incl. vault; KEK from SSM; no FORMULA_* key', () => {
  const b = box({ 'etc/rawprod/api.env': 'GIT_SHA=27db65039baf3de44d017167caf4b59fafd778f4\nFORMULA_KMS_KEY_ID=alias/rawprod-vault-envelope\n' }, PROD_PARAMS);
  try {
    const r = run(b, 'infra/aws/env/render-env.sh', 'app');
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(b, 'etc/rawprod/api.env');
    sameSet(e.keys(), LIVE.rawprodApi, '/etc/rawprod/api.env');
    assert.equal(e.get('RAWPROD_ASSERTION_EXPECTED_TARGETS'), 'factory,platform,vault');
    assert.equal(e.get('BRIDGE_HMAC_KEK'), PROD_PARAMS['/rawaroma/rawprod/bridge-hmac-kek']);
    // RC7: retired from the app box, even when the file being replaced still has one.
    for (const k of FORMULA_KEYS) assert.equal(e.has(k), false, `the app box must not carry ${k}`);
    assert.equal(e.get('CORS_ORIGINS'), 'https://rawfactory.huecycle.in,https://rawplatform.huecycle.in');
    assert.equal(e.get('RUN_WORKER_IN_PROCESS'), 'true');
    assert.equal(e.get('GIT_SHA'), '27db65039baf3de44d017167caf4b59fafd778f4');
    noSecretPrinted(r, b);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-env vault: the live production vault key set, rawvault CORS', () => {
  const b = box({ 'etc/rawprod/vault.env': 'GIT_SHA=27db65039baf3de44d017167caf4b59fafd778f4\n' }, PROD_PARAMS);
  try {
    const r = run(b, 'infra/aws/env/render-env.sh', 'vault');
    assert.equal(r.status, 0, r.stderr);
    const e = envOf(b, 'etc/rawprod/vault.env');
    sameSet(e.keys(), LIVE.rawprodVault, '/etc/rawprod/vault.env');
    assert.equal(e.get('CORS_ORIGINS'), 'https://rawvault.huecycle.in');
    assert.equal(e.get('FORMULA_KMS_KEY_ID'), PROD_PARAMS['/rawaroma/vault/FORMULA_KMS_KEY_ID']);
    for (const k of FORMULA_KEYS) assert.ok(e.get(k), `the vault box keeps ${k}`);
    noSecretPrinted(r, b);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('render-env app: migrate.env names the app role (DB_APP_ROLE) from the app DATABASE_URL, for the grant migration', () => {
  const b = box({}, PROD_PARAMS);
  try {
    const r = run(b, 'infra/aws/env/render-env.sh', 'app');
    assert.equal(r.status, 0, r.stderr);
    const m = envOf(b, 'etc/rawprod/migrate.env');
    sameSet(m.keys(), ['NODE_ENV', 'PGSSLROOTCERT', 'DATABASE_URL', 'SKIP_TARGETS', 'DB_APP_ROLE'], '/etc/rawprod/migrate.env');
    assert.equal(m.get('DB_APP_ROLE'), 'rawprod_app');
    assert.equal(m.get('DATABASE_URL'), PROD_PARAMS['/rawaroma/rawprod/MIGRATE_DATABASE_URL'], 'migrations still run as the owner');
    assert.equal(m.get('SKIP_TARGETS'), 'formula');
    noSecretPrinted(r, b);
  } finally { rmSync(b.root, { recursive: true, force: true }); }
  // An app URL with no user in it stops the render before any file is written.
  const nouser = box({}, { ...PROD_PARAMS, '/rawaroma/rawprod/DATABASE_URL': 'postgres://db.invalid/rawprod' });
  try {
    const r = run(nouser, 'infra/aws/env/render-env.sh', 'app');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no role name in \/rawaroma\/rawprod\/DATABASE_URL/);
    assert.equal(existsSync(join(nouser.root, 'etc/rawprod/api.env')), false);
    assert.equal(existsSync(join(nouser.root, 'etc/rawprod/migrate.env')), false);
  } finally { rmSync(nouser.root, { recursive: true, force: true }); }
});

// ── static roots and their config JS ─────────────────────────────────────────────────────────────
function webTrees(prefix: string): Record<string, string> {
  return {
    [`${prefix}/web/index.html`]: '<script src="/shell.js"></script>',
    [`${prefix}/web/shell.js`]: 'shell',
    [`${prefix}/web/README.md`]: 'not served',
    [`${prefix}/web/.dependency-cruiser.cjs`]: 'not served',
    [`${prefix}/web/build/out.txt`]: 'not served',
    [`${prefix}/web-platform/index.html`]: '<script src="/platform.js"></script>',
    [`${prefix}/web-vault/index.html`]: '<script src="/vault.js"></script>',
    [`${prefix}/web-vault/vault.js`]: 'vault',
  };
}
function installStatic(target: 'prod' | 'demo', files: Record<string, string>) {
  const b = box(files, {});
  const r = spawnSync('bash', [join(ROOT, 'infra/aws/nginx/install-static.sh'), target], {
    encoding: 'utf8', env: { ...process.env, RAWPROD_STATIC_PREFIX: b.root },
  });
  return { b, r };
}

for (const [target, src, www, cc, vc] of [
  ['demo', 'srv/rawprod-demo/app', 'var/www/rawprod-demo-cf', 'demo', 'demo-vault'],
  ['prod', 'srv/rawprod/app', 'var/www/rawprod-cf', 'prod', 'vault'],
] as const) {
  test(`install-static ${target}: factory/platform/vault roots as live, vault-config.js inside the vault root`, () => {
    const { b, r } = installStatic(target, webTrees(src));
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(readdirSync(join(b.root, www, 'factory')).sort(), ['index.html', 'shell.js']);
      assert.deepEqual(readdirSync(join(b.root, www, 'platform')), ['index.html']);
      assert.deepEqual(readdirSync(join(b.root, www, 'vault')).sort(), ['index.html', 'vault-config.js', 'vault.js']);
      assert.equal(readFileSync(join(b.root, www, 'vault/vault-config.js'), 'utf8'),
        read(`infra/aws/nginx/static-config/${vc}/vault-config.js`));
      assert.equal(readFileSync(join(b.root, `var/www/rawprod-config/${cc}/console-config.js`), 'utf8'),
        read(`infra/aws/nginx/static-config/${cc}/console-config.js`));
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });
}

test('install-static: a missing source tree is refused and the live root is left alone', () => {
  const files: Record<string, string> = { ...webTrees('srv/rawprod-demo/app'), 'var/www/rawprod-demo-cf/vault/index.html': 'LIVE' };
  delete files['srv/rawprod-demo/app/web-vault/index.html'];
  delete files['srv/rawprod-demo/app/web-vault/vault.js'];
  const { b, r } = installStatic('demo', files);
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /web-vault is missing or empty/);
    assert.equal(readFileSync(join(b.root, 'var/www/rawprod-demo-cf/vault/index.html'), 'utf8'), 'LIVE');
  } finally { rmSync(b.root, { recursive: true, force: true }); }
});

test('static-config: the demo vault config points at the DEMO console and is public-safe', () => {
  const demo = read('infra/aws/nginx/static-config/demo-vault/vault-config.js');
  assert.match(demo, /window\.MAIN_API = '\/main';/);
  assert.match(demo, /window\.ALEMBIC_CONSOLE_URL = 'https:\/\/rawdemoadmin\.huecycle\.in\/admin';/);
  assert.doesNotMatch(demo, /secret|token|password|key\s*[:=]/i);
  assert.doesNotMatch(read('infra/aws/nginx/static-config/vault/vault-config.js'), /rawdemo/);
});

// ── nginx: a static `nginx -t`-style pass over the vhosts enabled on the app box ─────────────────
// sites-enabled on i-04e7dc4e5edcc1ff7 (2026-09-25), in load order. alembic.conf and the default-deny are
// ALEMBIC's; they contribute the upstreams below. Every other file is this repo's.
const ENABLED = ['infra/aws/demo/nginx/rawaroma-demo-origin.conf', 'infra/aws/nginx/rawprod-cf-origin.conf',
  'infra/aws/nginx/huecycle-hosts.conf', 'infra/aws/nginx/rawdemovault.conf', 'infra/aws/nginx/rawvault.conf'];
const FROM_ALEMBIC_CONF = ['alembic_api', 'alembic_web'];
// ALEMBIC's ops/nginx/, installed to /etc/nginx/alembic/ (recorded there from live by lane cfg).
const ALEMBIC_SNIPPETS = ['security-headers.conf', 'security-headers-console.conf', 'security-headers-console-demo.conf'];
// Rendered on the box from SSM, never in git (install-box.sh / cloudfront/render-origin-secret.sh).
const RENDERED_SECRETS = ['/etc/nginx/rawaroma-demo/origin-secret.conf', '/etc/nginx/rawprod/cf-origin-secret.conf'];

/** Comments removed, quoted strings kept (a `#` inside quotes is not a comment). */
function code(conf: string): string {
  return conf.split('\n').map((line) => {
    let q = ''; let out = '';
    for (const ch of line) {
      if (q) { out += ch; if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
      if (ch === '#') break;
      out += ch;
    }
    return out;
  }).join('\n');
}
const all = ENABLED.map((f) => ({ f, c: code(read(f)) }));
const matches = (re: RegExp) => all.flatMap(({ f, c }) => [...c.matchAll(re)].map((m) => ({ f, m })));

test('nginx: every enabled vhost balances its braces', () => {
  for (const { f, c } of all) {
    let d = 0;
    for (const ch of c.replace(/"[^"]*"|'[^']*'/g, '""')) { if (ch === '{') d++; if (ch === '}') d--; assert.ok(d >= 0, f); }
    assert.equal(d, 0, `${f}: unbalanced braces`);
  }
});

test('nginx: one definition per upstream, limit_req zone and map variable across the enabled set', () => {
  for (const [what, re] of [['upstream', /^\s*upstream\s+(\S+)\s*\{/gm], ['limit_req_zone', /limit_req_zone\s+\S+\s+zone=([^:\s]+):/g],
    ['map', /^\s*map\s+\S+\s+(\$\S+)\s*\{/gm]] as const) {
    const names = matches(re).map(({ m }) => m[1]);
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], `duplicate ${what}`);
  }
  // http-level and set once (rawvault.conf); a second one is a duplicate-directive error.
  assert.equal(matches(/^\s*limit_req_status\s/gm).length, 1);
});

test('nginx: every proxy_pass upstream and limit_req zone resolves', () => {
  const ups = new Set([...matches(/^\s*upstream\s+(\S+)\s*\{/gm).map(({ m }) => m[1]), ...FROM_ALEMBIC_CONF]);
  for (const { f, m } of matches(/proxy_pass\s+https?:\/\/([A-Za-z0-9_]+)[/;]/g)) {
    assert.ok(ups.has(m[1]), `${f}: proxy_pass to undefined upstream ${m[1]}`);
  }
  const zones = new Set(matches(/limit_req_zone\s+\S+\s+zone=([^:\s]+):/g).map(({ m }) => m[1]));
  for (const { f, m } of matches(/limit_req\s+zone=([^\s;]+)/g)) assert.ok(zones.has(m[1]), `${f}: limit_req zone ${m[1]} undefined`);
});

test('nginx: every include resolves to a repo file, an ALEMBIC snippet, certbot, or a rendered secret', () => {
  for (const { f, m } of matches(/^\s*include\s+([^;\s]+);/gm)) {
    const p = m[1] ?? ''; // '' matches no allowed prefix, so a group that did not participate fails below
    if (p.startsWith('/etc/letsencrypt/') || RENDERED_SECRETS.includes(p)) continue;
    if (p.startsWith('/etc/nginx/alembic/')) { assert.ok(ALEMBIC_SNIPPETS.includes(p.slice(19)), `${f}: ${p}`); continue; }
    assert.ok(p.startsWith('/etc/nginx/rawprod/') && existsSync(join(ROOT, 'infra/aws/nginx', p.slice(19))), `${f}: ${p}`);
  }
});

test('nginx: one server per name and port across the enabled set', () => {
  const seen = new Map<string, string>();
  for (const { f, c } of all) {
    for (const blk of c.split(/^(?=server\s*\{)/m).slice(1)) {
      const names = (/server_name\s+([^;]+);/.exec(blk)?.[1] ?? '').trim().split(/\s+/);
      const ports = [...blk.matchAll(/^\s*listen\s+(?:\[::\]:)?(\d+)/gm)].map((m) => m[1]);
      for (const n of names) for (const p of new Set(ports)) {
        if (n === '_') continue;
        const k = `${n}:${p}`;
        assert.ok(!seen.has(k), `${k} served by ${seen.get(k)} and ${f}`);
        seen.set(k, f);
      }
    }
  }
  assert.ok(seen.has('rawdemovault.huecycle.in:443'));
});

test('nginx: rawdemovault.conf is the live demo vault vhost', () => {
  const v = read('infra/aws/nginx/rawdemovault.conf');
  assert.match(v, /server_name rawdemovault\.huecycle\.in;/);
  assert.match(v, /upstream rawdemovault_api_private \{ server 172\.31\.51\.157:4111;/);
  // RC7: /main/ reaches the main API only at the console tunnel's two paths, everything else under it is a 404
  // (was: all of /main/ proxied to the whole API). Selection-level proof: nginx-vault-main-channel.test.ts.
  assert.match(v, /location = \/main\/crypto\/handshake \{[^}]*proxy_pass http:\/\/rawprod_demo_api\/crypto\/handshake;/);
  assert.match(v, /location = \/main\/rpc \{[^}]*proxy_pass http:\/\/rawprod_demo_api\/rpc;/);
  assert.match(v, /location \^~ \/main\/ \{[^}]*return 404;/);
  assert.doesNotMatch(v, /proxy_pass http:\/\/rawprod_demo_api\/;/, 'the whole main API is no longer proxied');
  assert.match(v, /root \/var\/www\/rawprod-demo-cf\/vault;/);
  assert.match(v, /sub_filter '<script src="\/vault\.js"><\/script>' '<script src="\/vault-config\.js"><\/script><script src="\/vault\.js"><\/script>';/);
  for (const loc of v.match(/location[^{]*\{[^}]*\}/g) ?? []) {
    if (/proxy_pass|try_files \/vault-config/.test(loc)) {
      assert.match(loc, /include \/etc\/nginx\/rawprod\/security-headers-vault\.conf;/, `location without headers:\n${loc}`);
    }
  }
});

test('nginx: the demo console hosts use the DEMO console CSP, the production ones never do', () => {
  const blocks = code(read('infra/aws/nginx/huecycle-hosts.conf')).split(/^(?=server\s*\{)/m);
  const of = (name: string) => blocks.find((b) => new RegExp(`server_name ${name.replaceAll('.', '\\.')};`).test(b)) ?? '';
  for (const h of ['rawdemoadmin', 'rawdemoagent', 'rawdemostudio']) {
    const b = of(`${h}.huecycle.in`);
    assert.equal((b.match(/security-headers-console-demo\.conf/g) ?? []).length, 4, h);
    assert.doesNotMatch(b, /security-headers-console\.conf/, h);
  }
  assert.doesNotMatch(of('rawstudio.huecycle.in'), /console-demo/);
});

test('nginx: the demo factory origin injects console-config.js from the DEMO config', () => {
  const d = read('infra/aws/demo/nginx/rawaroma-demo-origin.conf');
  assert.match(d, /location = \/console-config\.js \{ root \/var\/www\/rawprod-config\/demo; try_files \/console-config\.js =404; \}/);
  assert.match(d, /sub_filter '<script src="\/shell\.js">' '<script src="\/console-config\.js"><\/script><script src="\/shell\.js">';/);
  assert.match(d, /sub_filter '<script src="\/platform\.js">' '<script src="\/console-config\.js"><\/script><script src="\/platform\.js">';/);
});

test('nginx: conf.d/rawprod-large-headers.conf exists, holds 4x32k header buffers, and both app installers put it in conf.d', () => {
  // Live since 2026-09-25: the RawProd owner token (257 permissions, ~12.3 KB) overflowed nginx's 4 8k default and the
  // owner was locked out of Factory at the proxy. Kept as defence in depth after the token is made small.
  const f = 'infra/aws/nginx/rawprod-large-headers.conf';
  assert.ok(existsSync(join(ROOT, f)), `${f} is missing`);
  const directives = code(read(f)).split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(directives, ['large_client_header_buffers 4 32k;'], 'http-level file: that one directive and nothing else');
  // conf.d is included at http level; a second http-level copy anywhere in the enabled set fails nginx -t as a duplicate.
  assert.deepEqual(matches(/large_client_header_buffers/g).map(({ f: file }) => file), []);
  const dest = /install -m 644 "\$(?:D|LIB)\/nginx\/rawprod-large-headers\.conf" \/etc\/nginx\/conf\.d\/rawprod-large-headers\.conf/;
  assert.match(read('infra/aws/install-ops.sh'), dest, 'install-ops.sh app does not install it into conf.d');
  assert.match(read('infra/aws/demo/install-box.sh'), dest, 'install-box.sh app does not install it into conf.d');
});

test('every script this lane touched is valid bash', () => {
  for (const f of ['infra/aws/env/render-env.sh', 'infra/aws/demo/render-demo-env.sh', 'infra/aws/nginx/install-static.sh',
    'infra/aws/install-ops.sh', 'infra/aws/demo/install-box.sh']) {
    const r = spawnSync('bash', ['-n', join(ROOT, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('DEPLOY_AWS.md makes scripts/db-seed.ts a REQUIRED prod+demo bootstrap step, with the env the script reads', () => {
  // The IAM tables were empty in BOTH environments until 2026-09-25: migrate creates them, nothing ran the seed.
  const doc = read('infra/aws/DEPLOY_AWS.md');
  const sec = doc.slice(doc.indexOf('## 4a. IAM bootstrap seed'), doc.indexOf('## 5. Env files'));
  assert.ok(sec.length > 200, 'the §4a IAM bootstrap section is missing');
  assert.match(sec, /`scripts\/db-seed\.ts` is REQUIRED \(prod AND demo\)/);
  for (const v of ['RAWPROD_ENVIRONMENT', 'BOOTSTRAP_OWNER_EMAIL', 'BOOTSTRAP_OWNER_PASSWORD', 'DATABASE_URL']) {
    assert.match(sec, new RegExp('`' + v + '`'), `§4a does not document ${v}`);
  }
  assert.match(sec, /random, per run, never stored/);
  assert.match(sec, /openssl rand/);
  assert.match(sec, /unset BOOTSTRAP_OWNER_PASSWORD/);
  assert.match(sec, /`production`/);
  assert.match(sec, /`demo`/);
  assert.match(doc, /IAM bootstrap seed \(§4a\) — required/, 'the install order does not point at §4a');
  // The doc names what the script actually reads, and the values the config schema accepts.
  const seed = read('scripts/db-seed.ts');
  for (const v of ['RAWPROD_ENVIRONMENT', 'BOOTSTRAP_OWNER_EMAIL', 'BOOTSTRAP_OWNER_PASSWORD', 'DATABASE_URL']) {
    assert.match(seed, new RegExp('process\\.env\\.' + v + '\\b'), `db-seed.ts no longer reads ${v}`);
  }
  assert.match(read('backend/backend-kernel/src/config/config.schema.ts'), /RAWPROD_ENVIRONMENT: z\.enum\(\['production', 'demo'\]\)/);
});
