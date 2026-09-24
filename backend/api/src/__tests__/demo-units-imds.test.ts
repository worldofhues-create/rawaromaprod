// H1 (security review RC .2): no demo process may reach IMDS (the box roles are PROD roles), and no demo
// env/config may carry credential_source=Ec2InstanceMetadata. Demo AWS access (where needed at all) is a
// short-lived demo-role session written by a root timer to a 0640 file. Static checks over infra/aws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DEMO = join(ROOT, 'infra/aws/demo');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const IMDS_DENY = /^IPAddressDeny=.*169\.254\.169\.254\/32.*fd00:ec2::254\/128/m;

const demoServices = readdirSync(join(DEMO, 'systemd')).filter(
  (f) => f.endsWith('.service') && !f.endsWith('-aws-creds.service'),
);

test('every demo app/migrate unit denies both IMDS endpoints and disables the SDK IMDS provider', () => {
  assert.ok(demoServices.length >= 7);
  for (const f of demoServices) {
    const s = readFileSync(join(DEMO, 'systemd', f), 'utf8');
    assert.match(s, IMDS_DENY, `${f} lacks IPAddressDeny for IMDS`);
    assert.match(s, /AWS_EC2_METADATA_DISABLED=true/, `${f} lacks AWS_EC2_METADATA_DISABLED`);
  }
});

test('the AWS-using demo units read the root-written demo session, after the refresher', () => {
  for (const [unit, dir, timer] of [
    ['alembic-demo-api.service', '/etc/alembic-demo/aws', 'alembic-demo-aws-creds'],
    ['vault-demo-api.service', '/etc/rawprod-demo/aws', 'vault-demo-aws-creds'],
  ] as const) {
    const s = readFileSync(join(DEMO, 'systemd', unit), 'utf8');
    assert.ok(s.includes(`AWS_CONFIG_FILE=${dir}/config`), unit);
    assert.ok(s.includes(`AWS_SHARED_CREDENTIALS_FILE=${dir}/credentials`), unit);
    assert.ok(s.includes(`After=${timer}.service`), unit);
  }
  // rawprod-demo-api calls no AWS API: no credentials at all
  assert.doesNotMatch(read('infra/aws/demo/systemd/rawprod-demo-api.service'), /AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE/);
});

test('no demo script or unit uses credential_source / instance metadata', () => {
  for (const f of ['render-demo-env.sh', 'demo-aws-creds.sh', 'reset-demo.sh', 'install-box.sh']) {
    const s = read(`infra/aws/demo/${f}`).split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    assert.doesNotMatch(s, /^\s*credential_source\s*=/m, f);
    assert.doesNotMatch(s, /role_arn\s*=/, f);
  }
});

test('the refresher assumes only the demo roles and writes 0640 root:<demo user> files, never printing secrets', () => {
  const s = read('infra/aws/demo/demo-aws-creds.sh');
  assert.match(s, /app\)\s+ROLE=alembic-demo-app;\s+GRP=alembic-demo;/);
  assert.match(s, /vault\)\s+ROLE=rawprod-vault-demo;\s+GRP=rawprod-demo;/);
  assert.match(s, /--duration-seconds 3600/);
  assert.match(s, /chmod 640 "\$t"/);
  assert.match(s, /credential_process = \/bin\/cat/);
  assert.doesNotMatch(s, /echo[^\n]*(SecretAccessKey|SessionToken|AccessKeyId)/);
  for (const t of ['alembic-demo-aws-creds.timer', 'vault-demo-aws-creds.timer']) {
    assert.match(readFileSync(join(DEMO, 'systemd', t), 'utf8'), /OnUnitActiveSec=30min/);
  }
});

test('the demo app role is narrow: inference + translate only, no S3/SSM/Secrets/Chime', () => {
  const p = JSON.parse(read('infra/aws/demo/iam/alembic-demo-app.policy.json')) as {
    Statement: { Action: string | string[] }[];
  };
  const actions = p.Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
  for (const a of actions) assert.match(a, /^(bedrock-mantle:CreateInference|bedrock:(InvokeModel|InvokeModelWithResponseStream|Converse|ConverseStream)|translate:TranslateText)$/);
});

test('production: rawprod-api denies IMDS; vault-api keeps it (KMS via its own instance role) and says so', () => {
  assert.match(read('infra/aws/systemd/rawprod-api.service'), IMDS_DENY);
  const v = read('infra/aws/systemd/vault-api.service');
  assert.doesNotMatch(v, /^IPAddressDeny=/m);
  assert.match(v, /IMDS deliberately NOT denied/);
});
