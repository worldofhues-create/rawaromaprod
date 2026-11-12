/**
 * SHIP-RP: infra/aws/ship.sh, run for real against a throwaway repository and a recorded `aws`.
 *
 * ship.sh is the one command that takes a pushed commit to production. What it must never do is the
 * list this file pins, each one a thing that has gone wrong or would:
 *   - deploy while Alembic (or another RawProd ship) is deploying on the same 3.8 GB box. On 2026-11-07
 *     the two builds ran together and the kernel killed Alembic's; the storefront was down ten minutes;
 *   - change anything on a dry run;
 *   - deploy without a backup taken by THIS run, or deploy after the backup failed;
 *   - run a deploy.sh other than the commit's own;
 *   - publish the consoles before deploy.sh's health check passed;
 *   - say green when the box does not run the commit or a host does not answer;
 *   - leave its lock behind.
 *
 * Like host-lock.test.ts: the script itself runs. `git` is real (an origin and a clone in a temp
 * directory), `aws`, `pnpm` and `curl` are stubs that write down what they were asked. The SSM scripts
 * ship.sh would send to the box are captured, and the lock ones are then executed here against a temp
 * lock directory with a real flock(2), so the exclusion below is the kernel's and not a simulation.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM, no types
import { verify, isReusableProof, LOCAL_GATES } from '../../../../infra/aws/ship-evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHIP = join(ROOT, 'infra/aws/ship.sh');
const BACKUP = join(ROOT, 'infra/aws/backup/rawprod-backup.sh');
const src = readFileSync(SHIP, 'utf8');
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const MAIN = 'i-04e7dc4e5edcc1ff7';
const VAULT = 'i-0edad222a96eeed07';
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), body.startsWith('#!') ? body : `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** `aws`, recorded. Every call is a line in calls.jsonl; every SSM script sent is kept in sent/. */
const AWS_STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const S = process.env.SHIP_TEST_STATE;
const a = process.argv.slice(2).filter((x, i, all) => !['--profile', '--region'].includes(x) && !['--profile', '--region'].includes(all[i - 1]));
const arg = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const log = (o) => fs.appendFileSync(path.join(S, 'calls.jsonl'), JSON.stringify(o) + '\\n');
const reply = (name, dflt) => { const f = path.join(S, 'reply', name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : dflt; };
const sent = () => fs.readFileSync(path.join(S, 'calls.jsonl'), 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const head = fs.readFileSync(path.join(S, 'head'), 'utf8').trim(), base = fs.readFileSync(path.join(S, 'base'), 'utf8').trim();
if (a[0] === 'ssm' && a[1] === 'send-command') {
  const doc = JSON.parse(fs.readFileSync(arg('--cli-input-json').replace('file://', ''), 'utf8'));
  const kind = doc.Comment.replace('rawprod-ship:', '');
  const blob = /echo (\\S+) \\| base64 -d/.exec(doc.Parameters.commands[0])[1];
  const n = fs.readdirSync(path.join(S, 'sent')).length + 1;
  fs.writeFileSync(path.join(S, 'sent', String(n).padStart(2, '0') + '-' + kind + '.sh'), Buffer.from(blob, 'base64'));
  log({ op: 'send', kind, instance: doc.InstanceIds[0], commands: doc.Parameters.commands.length });
  process.stdout.write('cmd-' + kind + '\\n');
} else if (a[0] === 'ssm' && a[1] === 'get-command-invocation') {
  const kind = arg('--command-id').replace('cmd-', ''), q = arg('--query');
  const deployed = sent().some((c) => c.op === 'send' && c.kind === 'deploy') ? head : base;
  const out = {
    status: 'deployed=' + reply('deployed', deployed) + '\\nprevious=none\\ncheckout=' + deployed + '\\nmem_available_mb=' + reply('mem', '2400') + '\\nship_lock=' + reply('ship_lock', 'free') + '\\ndeploy_flock=' + reply('deploy_flock', 'free'),
    'lock-take': 'locked=yes',
    'lock-release': 'released=yes',
    unlock: 'removed=system=alembic',
    backup: 'rawprod-backup OK bucket=b key=rawprod/pg_dump/' + reply('backup_stamp', '99991231T235959Z') + '.dump bytes=1800000 sha256=abc entries=40 tables=12',
    deploy: 'wrapper=x\\n==> DEPLOYED\\nlog=/var/log/rawprod-ship/x.log\\ndeploy_exit=0',
    static: 'published /var/www/rawprod-cf/factory\\npublished /var/www/rawprod-cf/platform\\npublished /var/www/rawprod-cf/vault',
  };
  if (q === 'Status') process.stdout.write(reply(kind + '.status', 'Success') + '\\n');
  else if (q === 'StandardOutputContent') process.stdout.write(reply(kind + '.out', out[kind] || '') + '\\n');
  else process.stdout.write('\\n');
} else if (a[0] === 's3api' && a[1] === 'head-object') {
  log({ op: 's3-head', key: arg('--key') });
  if (reply('s3', 'ok') !== 'ok') process.exit(254);
  process.stdout.write(reply('s3.bytes', '1800000') + '\\n');
} else if (a[0] === 'rds') {
  log({ op: 'rds', db: arg('--db-instance-identifier') });
  process.stdout.write(reply('pitr', new Date(Date.now() - 60000).toISOString()) + '\\n');
} else { log({ op: 'other', a }); process.exit(2); }
`;

type Call = { op: string; kind?: string; instance?: string; key?: string; db?: string };

/** An origin, a clone of it, and a PATH on which aws, pnpm and curl only take notes. */
function rig(opt: { pushHead?: boolean; lockInDeploy?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-rp-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  const origin = join(dir, 'origin.git');
  const clone = join(dir, 'clone');
  [bin, state, join(state, 'sent'), join(state, 'reply'), join(dir, 'tmp')].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(join(state, 'calls.jsonl'), '');
  writeFileSync(join(state, 'pnpm.log'), '');

  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' });
  const put = (p: string, text: string) => { mkdirSync(dirname(join(clone, p)), { recursive: true }); writeFileSync(join(clone, p), text); };
  const deploySh = `#!/usr/bin/env bash\n# the wrapper\n${opt.lockInDeploy === false ? '' : 'HOST_LOCK=/run/lock/raw-host-deploy.lock\n'}echo deploy "$@"\n`;
  put('infra/aws/deploy.sh', deploySh);
  put('infra/aws/nginx/install-static.sh', '#!/usr/bin/env bash\necho published\n');
  put('package.json', '{"name":"t","private":true}\n');
  put('web/index.html', '<html>one</html>\n');
  g(clone, 'add', '.');
  g(clone, 'commit', '--quiet', '-m', 'base');
  const base = g(clone, 'rev-parse', 'HEAD');
  g(clone, 'push', '--quiet', 'origin', 'HEAD:main');
  put('web/index.html', '<html>two</html>\n');
  g(clone, 'commit', '--quiet', '-am', 'head');
  const head = g(clone, 'rev-parse', 'HEAD');
  if (opt.pushHead !== false) g(clone, 'push', '--quiet', 'origin', 'HEAD:main');
  writeFileSync(join(state, 'head'), head);
  writeFileSync(join(state, 'base'), base);

  stub(bin, 'aws', AWS_STUB);
  stub(bin, 'pnpm', `echo "pnpm $*" >> "${join(state, 'pnpm.log')}"`);
  stub(bin, 'curl', `printf '%s' "$(cat "${join(state, 'reply', 'curl')}" 2>/dev/null || echo 200)"`);
  stub(bin, 'sleep', '');

  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: dir,
    TMPDIR: join(dir, 'tmp'),
    SHIP_REPO: clone,
    SHIP_TEST_STATE: state,
    SHIP_SSM_POLL_S: '0',
    SHIP_HEALTH_RETRY_S: '0',
    SHIP_MIN_FREE_GB: '0',
    RAWPROD_SHIP_EVIDENCE: join(dir, 'evidence'),
  };
  const run = (args: string[]) => {
    const r = spawnSync('bash', [SHIP, ...args], { encoding: 'utf8', env });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const calls = (): Call[] => readFileSync(join(state, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call);
  const order = () => calls().map((c) => c.kind ?? c.op);
  const reply = (name: string, text: string) => writeFileSync(join(state, 'reply', name), text);
  const sent = (kind: string) => {
    const f = readdirSync(join(state, 'sent')).sort().find((n) => n.endsWith(`-${kind}.sh`));
    assert.ok(f, `no ${kind} script was sent`);
    return readFileSync(join(state, 'sent', f!), 'utf8');
  };
  const evidence = () => {
    const d = join(dir, 'evidence', head);
    if (!existsSync(d)) return [];
    return readdirSync(d).sort().map((run) => JSON.parse(readFileSync(join(d, run, 'ship.json'), 'utf8')) as {
      verdict: string; mode: string; sha: string; base: string; local_proof: string; seal: string; finished: string;
      gates: { name: string; status: string; detail: string }[]; notes: string[];
    });
  };
  const worktrees = () => g(clone, 'worktree', 'list').split('\n').length;
  return { dir, clone, state, base, head, deploySh, g, put, run, calls, order, reply, sent, evidence, worktrees,
    pnpm: () => readFileSync(join(state, 'pnpm.log'), 'utf8') };
}

// ── a dry run changes nothing ───────────────────────────────────────────────────────────────────────

test('a dry run proves the commit locally, reads the box once, and sends nothing that changes it', () => {
  const r = rig();
  const x = r.run([r.head]);
  assert.equal(x.code, 0, x.out);
  assert.deepEqual(r.order(), ['status'], 'one read-only SSM command, the status read');
  assert.match(x.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: take the ship lock/);
  assert.match(x.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: pg_dump -Fc of rawprod/);
  assert.match(x.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: install [0-9a-f]{8}'s own deploy\.sh/);
  assert.match(x.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: infra\/aws\/nginx\/install-static\.sh prod/);
  assert.match(x.out, /WOULD CHECK: https:\/\/rawfactory\.huecycle\.in\/health, https:\/\/rawplatform\.huecycle\.in\/health, https:\/\/rawvault\.huecycle\.in\/health/);
  assert.match(x.out, /VERDICT: DRY RUN PASSED/);
  // The local steps ran for real: install, typecheck, and the build the box runs, in a fresh worktree.
  const p = r.pnpm();
  assert.match(p, /pnpm -C \S+\/head install --frozen-lockfile/);
  assert.match(p, /pnpm -C \S+\/head typecheck/);
  assert.match(p, /pnpm -C \S+\/head -r --workspace-concurrency=1 --filter !@core\/admin-shell --filter !@core\/api build/);
  assert.equal(r.worktrees(), 1, 'the worktree is removed after a pass');
});

test('--offline makes no AWS call at all, and needs to be told what production runs', () => {
  const r = rig();
  const x = r.run([r.head, '--offline', '--base', r.base]);
  assert.equal(x.code, 0, x.out);
  assert.deepEqual(r.calls(), []);
  assert.match(x.out, /host lock .*--offline: the box was not asked/);
  const noBase = r.run([r.head, '--offline']);
  assert.notEqual(noBase.code, 0);
  assert.match(noBase.out, /--offline cannot read what production runs/);
  assert.notEqual(r.run([r.head, '--offline', '--base', r.base, '--apply']).code, 0, '--offline cannot deploy');
  assert.deepEqual(r.calls(), []);
});

test('every run leaves a sealed evidence file, a failed one included', () => {
  const r = rig();
  r.run([r.head]);
  const [e] = r.evidence();
  assert.ok(e, 'ship.json was written');
  assert.equal(verify(e), true, 'the seal matches the content');
  assert.equal(e!.sha, r.head);
  assert.equal(e!.base, r.base);
  assert.equal(e!.mode, 'dry-run');
  assert.equal(e!.local_proof, 'ok');
  for (const name of LOCAL_GATES as string[]) assert.ok(e!.gates.some((g) => g.name === name), `gate "${name}" is recorded`);
  assert.equal(verify({ ...e, verdict: 'DEPLOYED GREEN' }), false, 'an edited file no longer verifies');

  const bad = rig();
  bad.reply('ship_lock', 'system=alembic role=main sha=abc started=2026-11-12T08:00:00Z by=op@laptop');
  assert.notEqual(bad.run([bad.head, '--apply']).code, 0);
  const [f] = bad.evidence();
  assert.match(f!.verdict, /^FAILED at local: REFUSED/);
  assert.equal(verify(f), true);
});

// ── one deploy per host ─────────────────────────────────────────────────────────────────────────────

test('--apply refuses while an Alembic ship holds the lock, names the holder, and touches nothing', () => {
  const r = rig();
  r.reply('ship_lock', 'system=alembic role=main sha=0123abcd started=2026-11-12T08:00:00Z by=op@laptop');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /REFUSED: the ship lock on i-04e7dc4e5edcc1ff7 is held: system=alembic role=main sha=0123abcd started=2026-11-12T08:00:00Z/);
  assert.match(x.out, /One deploy per host/);
  assert.deepEqual(r.order(), ['status'], 'no lock, no backup, no deploy was sent');
  assert.equal(r.pnpm(), '', 'and the laptop did not spend ten minutes building first');
});

test('--apply refuses while a deploy process holds the kernel lock, whichever system started it', () => {
  for (const holder of ['held by alembic pid 4242 since 2026-11-12T08:00:00Z', 'held by rawprod pid 77 since 2026-11-12T08:00:00Z']) {
    const r = rig();
    r.reply('deploy_flock', holder);
    const x = r.run([r.head, '--apply']);
    assert.notEqual(x.code, 0);
    assert.match(x.out, new RegExp(`REFUSED: a deploy is running on ${MAIN} right now \\(${holder}\\)`));
    assert.deepEqual(r.order(), ['status']);
  }
});

test('a dry run under a held lock still proves the commit, and says --apply would be refused', () => {
  const r = rig();
  r.reply('ship_lock', 'system=alembic role=main sha=0123abcd started=2026-11-12T08:00:00Z by=op@laptop');
  const x = r.run([r.head]);
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /HELD\s+host lock/);
  assert.match(x.out, /--apply would be REFUSED right now: the ship lock on .* is held: system=alembic/);
});

test('two ships that both saw a free lock: the one the box refuses stops before the backup', () => {
  const r = rig();
  r.reply('lock-take.status', 'Failed');
  r.reply('lock-take.out', 'REFUSED: the ship lock is held: system=alembic role=main sha=0123abcd started=2026-11-12T08:00:00Z by=op@laptop');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /REFUSED: the ship lock is held: system=alembic.*One deploy per host\. Nothing on i-04e7dc4e5edcc1ff7 was changed/);
  assert.deepEqual(r.order(), ['status', 'lock-take'], 'no backup, no deploy, and no release of a lock that was never ours');
});

test('the lock scripts, run for real: O_EXCL on the ship lock, flock(2) on the deploy lock, release only of our own line', async () => {
  const r = rig();
  assert.equal(r.run([r.head, '--apply']).code, 0);
  r.reply('ship_lock', 'system=rawprod role=main sha=dead started=then by=gone');
  assert.equal(r.run(['--unlock', '--apply']).code, 0, 'the unlock script is captured for the end of this test');
  const lockDir = join(r.dir, 'run-lock');
  const etc = join(r.dir, 'etc-rawprod');
  mkdirSync(lockDir);
  const bin = join(r.dir, 'lockbin');
  mkdirSync(bin);
  // macOS has no flock(1). `flock -n FILE CMD`, with a real flock(2) underneath.
  stub(bin, 'flock', `exec python3 -c '
import fcntl, sys, subprocess
f = open(sys.argv[2], "a")
try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError: sys.exit(1)
sys.exit(subprocess.call(sys.argv[3:]))
' "$@"`);
  const local = (kind: string, line?: string) => {
    let s = r.sent(kind)
      .replace(/^SHIP_LOCK=.*$/m, `SHIP_LOCK=${join(lockDir, 'raw-host-ship.lock')}`)
      .replace(/^DEPLOY_LOCK=.*$/m, `DEPLOY_LOCK=${join(lockDir, 'raw-host-deploy.lock')}`)
      .replaceAll('/etc/rawprod', etc);
    if (line) s = s.replace(/^LOCK_LINE=.*$/m, `LOCK_LINE='${line}'`);
    const x = spawnSync('bash', ['-c', s], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } });
    return { code: x.status, out: `${x.stdout}${x.stderr}` };
  };
  const ship = join(lockDir, 'raw-host-ship.lock');

  const first = local('lock-take');
  assert.equal(first.code, 0, first.out);
  const ours = readFileSync(ship, 'utf8').trim();
  assert.match(ours, new RegExp(`^system=rawprod role=main sha=${r.head} started=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ by=\\S+$`), 'the lock says who, what and since when');

  const second = local('lock-take', 'system=alembic role=main sha=feed started=now by=other');
  assert.equal(second.code, 75);
  assert.match(second.out, new RegExp(`REFUSED: the ship lock is held: system=rawprod role=main sha=${r.head}`));
  assert.equal(readFileSync(ship, 'utf8').trim(), ours, 'the loser did not overwrite the holder');

  // Somebody else's release leaves our lock alone; ours removes it and writes the box log.
  assert.match(local('lock-release', 'system=alembic role=main sha=feed started=now by=other').out, /released=not-ours/);
  assert.ok(existsSync(ship));
  assert.match(local('lock-release').out, /released=yes/);
  assert.equal(existsSync(ship), false);
  const logLine = JSON.parse(readFileSync(join(etc, 'ship-log.jsonl'), 'utf8').trim().split('\n').pop()!) as { sha: string; role: string; verdict: string };
  assert.equal(logLine.sha, r.head);
  assert.match(logLine.verdict, /DEPLOYED GREEN/);

  // A deploy process holding the kernel lock, the way deploy.sh and Alembic's deploy-sha.sh hold it.
  const holder = spawn('python3', ['-c', `
import fcntl, sys, time
f = open(sys.argv[1], 'a')
fcntl.flock(f, fcntl.LOCK_EX)
f.write('alembic pid 42 since then\\n'); f.flush()
print('held', flush=True)
time.sleep(60)
`, join(lockDir, 'raw-host-deploy.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  try {
    const blocked = local('lock-take');
    assert.equal(blocked.code, 75);
    assert.match(blocked.out, /REFUSED: a deploy holds the host lock: alembic pid 42 since then/);
    assert.equal(existsSync(ship), false, 'no ship lock is left behind by a refusal');
    assert.match(local('status').out, /deploy_flock=held by alembic pid 42 since then/);
    // The override does not outrank a running deploy: --unlock leaves the lock while the flock is held.
    writeFileSync(ship, 'system=rawprod role=main sha=dead started=then by=gone\n');
    const busy = local('unlock');
    assert.equal(busy.code, 75);
    assert.match(busy.out, /REFUSED: a deploy holds the host lock right now: alembic pid 42 since then/);
    assert.ok(existsSync(ship));
  } finally {
    const gone = new Promise((resolve) => holder.once('exit', resolve));
    holder.kill();
    await gone;
  }
  const cleared = local('unlock');
  assert.equal(cleared.code, 0, cleared.out);
  assert.match(cleared.out, /removed=system=rawprod role=main sha=dead/);
  assert.equal(existsSync(ship), false);
});

test('--unlock is the manual override: it shows the lock, refuses while a deploy runs, and removes it only with --apply', () => {
  const r = rig();
  r.reply('ship_lock', 'system=rawprod role=main sha=dead started=2026-11-11T08:00:00Z by=gone@laptop');
  const dry = r.run(['--unlock']);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /ship lock on i-04e7dc4e5edcc1ff7 : system=rawprod role=main sha=dead/);
  assert.match(dry.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: remove \/run\/lock\/raw-host-ship\.lock/);
  assert.deepEqual(r.order(), ['status']);

  r.reply('deploy_flock', 'held by alembic pid 42 since then');
  const busy = r.run(['--unlock', '--apply']);
  assert.notEqual(busy.code, 0);
  assert.match(busy.out, /a deploy is running .* The lock is not stale/);
  assert.deepEqual(r.order(), ['status', 'status'], 'nothing was removed');

  r.reply('deploy_flock', 'free');
  const done = r.run(['--unlock', '--apply']);
  assert.equal(done.code, 0, done.out);
  assert.deepEqual(r.order().slice(-2), ['status', 'unlock']);
  assert.match(r.sent('unlock'), /flock -n "\$DEPLOY_LOCK" true \|\| \{ echo "REFUSED/, 'the box checks again before removing');
});

// ── the order of a deploy ───────────────────────────────────────────────────────────────────────────

test('--apply: lock, backup read back from S3, the commit\'s own deploy.sh, the consoles, health, release', () => {
  const r = rig();
  const x = r.run([r.head, '--apply']);
  assert.equal(x.code, 0, x.out);
  assert.deepEqual(r.order(), ['status', 'lock-take', 'backup', 's3-head', 'deploy', 'static', 'status', 'lock-release']);
  assert.ok(r.calls().filter((c) => c.op === 'send').every((c) => c.instance === MAIN));
  assert.match(x.out, /VERDICT: DEPLOYED GREEN/);
  assert.match(x.out, /ship lock released/);

  // The wrapper that runs is the commit's, proven by hash on the box before it is installed.
  const deploy = r.sent('deploy');
  assert.match(deploy, new RegExp(`^WANT_DEPLOY_SHA256=${sha256(r.deploySh)}$`, 'm'));
  assert.match(deploy, new RegExp(`^SHA=${r.head}$`, 'm'));
  assert.match(deploy, /^ROLE=main$/m);
  const iShow = deploy.indexOf('git -C "$APP" show "$SHA:infra/aws/deploy.sh"');
  const iCmp = deploy.indexOf('[ "$got" = "$WANT_DEPLOY_SHA256" ] ||');
  const iInstall = deploy.indexOf('/usr/local/sbin/rawprod-deploy; rm -f');
  const iRun = deploy.indexOf('RAWPROD_ROLE="$ROLE" /usr/local/sbin/rawprod-deploy "$SHA"');
  assert.ok(iShow > 0 && iShow < iCmp && iCmp < iInstall && iInstall < iRun, 'show, compare, install, run: in that order');

  // The consoles: only once DEPLOYED_SHA (written by deploy.sh after ITS health check) is this commit.
  const stat = r.sent('static');
  assert.ok(stat.indexOf('[ "$(cat /srv/rawprod/DEPLOYED_SHA 2>/dev/null)" = "$SHA" ] ||') < stat.indexOf('install-static.sh" prod'));
  assert.match(stat, /bash "\$APP\/infra\/aws\/nginx\/install-static\.sh" prod/);

  // The backup script that runs on the box is the one in this repository, byte for byte.
  const backup = r.sent('backup');
  assert.match(backup, new RegExp(`^WANT_BACKUP_SHA256=${sha256(readFileSync(BACKUP))}$`, 'm'));
  const b64 = /^BACKUP_B64=(\S+)$/m.exec(backup)![1]!;
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), readFileSync(BACKUP, 'utf8'));

  const e = r.evidence().pop()!;
  assert.match(e.verdict, /^DEPLOYED GREEN/);
  assert.equal(e.gates.find((g) => g.name === 'backup')!.status, 'ok');
  assert.match(e.gates.find((g) => g.name === 'backup')!.detail, /rawprod\/pg_dump\/99991231T235959Z\.dump, 1800000 bytes, read back/);
});

test('a failed backup stops the ship before the deploy, and the lock is released', () => {
  const r = rig();
  r.reply('backup.status', 'Failed');
  r.reply('backup.out', 'rawprod-backup FAILED: pg_dump failed');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /the backup failed, so nothing was deployed/);
  assert.deepEqual(r.order(), ['status', 'lock-take', 'backup', 'lock-release']);
});

test('a backup that is not this run\'s, or not the size the box dumped, is not a backup', () => {
  // Review focus 3 of the plan: an object older than the ship (last week's drill) must not count.
  const old = rig();
  old.reply('backup_stamp', '20200101T000000Z');
  const a = old.run([old.head, '--apply']);
  assert.notEqual(a.code, 0);
  assert.match(a.out, /is older than this ship .* No deploy was started/);
  assert.equal(old.order().includes('deploy'), false);
  assert.equal(old.order().pop(), 'lock-release');

  const short = rig();
  short.reply('s3.bytes', '12');
  const b = short.run([short.head, '--apply']);
  assert.notEqual(b.code, 0);
  assert.match(b.out, /is 12 bytes and the box dumped 1800000\. No deploy was started/);
  assert.equal(short.order().includes('deploy'), false);

  const gone = rig();
  gone.reply('s3', 'missing');
  const c = gone.run([gone.head, '--apply']);
  assert.notEqual(c.code, 0);
  assert.match(c.out, /cannot be read back\. No deploy was started/);
  assert.equal(gone.order().includes('deploy'), false);
});

test('a failed deploy.sh publishes no console, prints the way back, and releases the lock', () => {
  const r = rig();
  r.reply('deploy.status', 'Failed');
  r.reply('deploy.out', 'FATAL: build failed (exit 137)\ndeploy_exit=1');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /FATAL: build failed \(exit 137\)/, 'the end of deploy.sh\'s output is shown');
  assert.match(x.out, /rawprod-deploy --rollback/);
  assert.deepEqual(r.order(), ['status', 'lock-take', 'backup', 's3-head', 'deploy', 'lock-release']);
  assert.match(r.evidence().pop()!.verdict, /^DEPLOY FAILED/);
});

test('green is said only when the box runs the commit and all three hosts answer /health', () => {
  const red = rig();
  red.reply('curl', '502');
  const a = red.run([red.head, '--apply']);
  assert.notEqual(a.code, 0);
  assert.match(a.out, /DEPLOYED BUT NOT GREEN: https:\/\/rawfactory\.huecycle\.in\/health answered 502; https:\/\/rawplatform\.huecycle\.in\/health answered 502; https:\/\/rawvault\.huecycle\.in\/health answered 502/);
  assert.match(a.out, /rawprod-deploy --rollback/);
  assert.equal(red.order().pop(), 'lock-release');

  const stale = rig();
  // deploy.sh "succeeded" but the box still reports the old commit.
  stale.reply('static.status', 'Failed');
  stale.reply('static.out', `REFUSED: DEPLOYED_SHA is not ${stale.head}, so the consoles are not published`);
  const b = stale.run([stale.head, '--apply']);
  assert.notEqual(b.code, 0);
  assert.match(b.out, /DEPLOYED BUT NOT GREEN|consoles were not published/);

  const wrong = rig();
  wrong.reply('deployed', wrong.base);
  wrong.reply('static.status', 'Success');
  const c = wrong.run([wrong.head, '--apply', '--base', wrong.base]);
  assert.notEqual(c.code, 0);
  assert.match(c.out, /DEPLOYED BUT NOT GREEN: DEPLOYED_SHA on the box is [0-9a-f]{40}, not [0-9a-f]{8}/);
});

// ── what may be shipped at all ──────────────────────────────────────────────────────────────────────

test('a commit that is not on origin is refused with the push command, before anything is read', () => {
  const r = rig({ pushHead: false });
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /is on no branch of origin, so the box cannot fetch it\. Push it first: git push origin [0-9a-f]{40}:refs\/heads\/<branch>/);
  assert.deepEqual(r.calls(), []);
});

test('a deployed commit this clone has never seen is refused, not diffed against nothing', () => {
  const r = rig();
  r.reply('deployed', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  const x = r.run([r.head]);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /production runs deadbeefdeadbeefdeadbeefdeadbeefdeadbeef, and that commit is not in this clone/);
  assert.equal(r.pnpm(), '');
});

test('a commit that does not descend from production is refused: that is a rollback, and deploy.sh guards those', () => {
  const r = rig();
  const x = r.run([r.base, '--base', r.head, '--offline']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /does not descend from what production runs/);
});

test('--base that contradicts the box is refused', () => {
  const r = rig();
  const x = r.run([r.head, '--base', r.head]);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /--base says production runs [0-9a-f]{8}, the box says [0-9a-f]{8}/);
});

test('a commit whose deploy.sh does not take the host lock is not shipped', () => {
  const r = rig({ lockInDeploy: false });
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /does not take \/run\/lock\/raw-host-deploy\.lock, so its build could run beside Alembic's/);
  assert.deepEqual(r.order(), ['status']);
});

test('a red local gate stops the ship before production is touched, and keeps the worktree to read', () => {
  const r = rig();
  writeFileSync(join(r.dir, 'bin/pnpm'), `#!/usr/bin/env bash\necho "pnpm $*" >> "${join(r.state, 'pnpm.log')}"\ncase "$*" in *typecheck*) echo "error TS2345: nope"; exit 2;; esac\n`);
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /FAILED\s+typecheck/);
  assert.match(x.out, /error TS2345: nope/, 'the end of the gate\'s log is printed');
  assert.match(x.out, /kept for reading: /);
  assert.deepEqual(r.order(), ['status']);
  assert.doesNotMatch(r.pnpm(), /build/, 'the build did not run after a red typecheck');
  assert.equal(r.evidence().pop()!.local_proof, 'incomplete');
});

// ── one proof per commit ────────────────────────────────────────────────────────────────────────────

test('--apply after a dry run reuses its proof; --reprove, another base, or an edited file does not', () => {
  const r = rig();
  assert.equal(r.run([r.head]).code, 0);
  const built = r.pnpm();
  const x = r.run([r.head, '--apply']);
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /reused\s+local proof/);
  assert.equal(r.pnpm(), built, 'nothing was built a second time');
  assert.equal(r.evidence().find((e) => e.mode === 'apply')!.local_proof, 'reused');

  assert.equal(r.run([r.head, '--reprove']).code, 0);
  assert.notEqual(r.pnpm(), built, '--reprove builds again');

  const proof = r.evidence().find((e) => e.mode === 'dry-run' && e.local_proof === 'ok')!;
  const tool = sha256(readFileSync(SHIP));
  const ask = { sha: r.head, base: r.base, role: 'main', tool };
  assert.equal(isReusableProof(proof, ask), true);
  assert.equal(isReusableProof(proof, { ...ask, base: r.head }), false, 'production moved: prove again');
  assert.equal(isReusableProof(proof, { ...ask, role: 'vault' }), false);
  assert.equal(isReusableProof(proof, { ...ask, tool: 'another ship.sh' }), false);
  assert.equal(isReusableProof(proof, { ...ask, now: Date.parse(proof.finished) + 25 * 3600 * 1000 }), false, 'a day old');
  assert.equal(isReusableProof({ ...proof, local_proof: 'ok', gates: [] }, ask), false, 'edited after the seal');
});

// ── the vault box ───────────────────────────────────────────────────────────────────────────────────

test('--role vault: its own box and lock, RDS point-in-time recovery instead of a dump, no console publish', () => {
  const r = rig();
  const x = r.run([r.head, '--role', 'vault', '--apply']);
  assert.equal(x.code, 0, x.out);
  assert.deepEqual(r.order(), ['status', 'lock-take', 'rds', 'deploy', 'status', 'lock-release']);
  assert.ok(r.calls().filter((c) => c.op === 'send').every((c) => c.instance === VAULT));
  assert.equal(r.calls().find((c) => c.op === 'rds')!.db, 'vault-pg');
  assert.match(r.sent('deploy'), /^ROLE=vault$/m);
  assert.match(x.out, /skipped\s+publish consoles/);

  const stale = rig();
  stale.reply('pitr', new Date(Date.now() - 3600 * 1000).toISOString());
  const y = stale.run([stale.head, '--role', 'vault', '--apply']);
  assert.notEqual(y.code, 0);
  assert.match(y.out, /vault-pg can be restored only to .* the limit is 900s\. No deploy was started/);
  assert.equal(stale.order().includes('deploy'), false);
  assert.equal(stale.order().pop(), 'lock-release');
});

// ── the on-box backup script ────────────────────────────────────────────────────────────────────────

function backupRig(opt: { bytes?: number; list?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-rp-backup-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  writeFileSync(join(dir, 'migrate.env'), 'NODE_ENV=production\nDATABASE_URL=postgres://owner:not-a-real-secret@db/rawprod\nSKIP_TARGETS=formula\n');
  writeFileSync(join(dir, 'list.txt'), `${opt.list ?? ';\n; Archive\n1; 0 0 TABLE public t owner\n2; 0 0 TABLE DATA public t owner'}\n`);
  stub(bin, 'pg_dump', `echo "pg_dump $2" >> "${calls}"\nhead -c ${opt.bytes ?? 600000} /dev/zero > "$4"`);
  stub(bin, 'pg_restore', `echo "pg_restore $1" >> "${calls}"\ncat "${join(dir, 'list.txt')}"`);
  stub(bin, 'aws', `echo "aws $*" >> "${calls}"`);
  const run = (extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [BACKUP], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, RAWPROD_BACKUP_ENVFILE: join(dir, 'migrate.env'), ...extra } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { dir, run, calls: () => readFileSync(calls, 'utf8') };
}

test('rawprod-backup.sh: dump, read back, upload, one line for ship.sh, and the URL never printed', () => {
  const b = backupRig();
  const x = b.run();
  assert.equal(x.code, 0, x.err);
  assert.match(x.out, /^rawprod-backup OK bucket=alembic-backups-859485559854-usw2 key=rawprod\/pg_dump\/\d{8}T\d{6}Z\.dump bytes=600000 sha256=[0-9a-f]{64} entries=2 tables=1$/m);
  const c = b.calls();
  assert.ok(c.indexOf('pg_dump') < c.indexOf('pg_restore --list') && c.indexOf('pg_restore --list') < c.indexOf('aws s3 cp'), 'dump, read back, then upload');
  assert.match(c, /aws s3 cp --only-show-errors --sse AES256 \S+ s3:\/\/alembic-backups-859485559854-usw2\/rawprod\/pg_dump\/\d{8}T\d{6}Z\.dump/);
  assert.doesNotMatch(`${x.out}${x.err}`, /not-a-real-secret/);
});

test('rawprod-backup.sh: an archive that is too small, holds no table data, or has no URL is not uploaded', () => {
  const small = backupRig({ bytes: 1000 });
  const a = small.run();
  assert.notEqual(a.code, 0);
  assert.match(a.err, /rawprod-backup FAILED: the archive is 1000 bytes, under the floor of 500000/);
  assert.doesNotMatch(small.calls(), /aws s3 cp/);

  const empty = backupRig({ list: ';\n; Archive\n1; 0 0 TABLE public t owner' });
  const b = empty.run();
  assert.notEqual(b.code, 0);
  assert.match(b.err, /lists no table data/);
  assert.doesNotMatch(empty.calls(), /aws s3 cp/);

  const none = backupRig();
  const c = none.run({ RAWPROD_BACKUP_ENVFILE: join(none.dir, 'absent.env') });
  assert.notEqual(c.code, 0);
  assert.match(c.err, /so the database URL cannot be read/);
});

// ── the script text ─────────────────────────────────────────────────────────────────────────────────

test('ship.sh and the backup script are valid bash', () => {
  execFileSync('bash', ['-n', SHIP]);
  execFileSync('bash', ['-n', BACKUP]);
});

test('ship.sh sequences and refuses; deploy.sh stays the only deployment implementation', () => {
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /pkill|killall/);
  assert.doesNotMatch(code, /systemctl\s+(restart|start|stop)/, 'no unit is restarted from here');
  assert.doesNotMatch(code, /checkout\s+(--quiet\s+)?--detach/, 'nothing is checked out on the box from here');
  assert.doesNotMatch(code, /get-secret-value/);
  assert.match(code, /\/usr\/local\/sbin\/rawprod-deploy "\$SHA"/);
  // On the box, a build happens only inside deploy.sh: no remote script names pnpm.
  const remote = code.slice(code.indexOf('remote_head() {'), code.indexOf('sha256_of() {'));
  assert.doesNotMatch(remote, /pnpm/);
});

test('every SSM command goes through ssm_read or ssm_apply, and only ssm_apply changes the box', () => {
  const sends = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /\bssm_send\b/.test(l) && !/^\s*#/.test(l) && !/^ssm_send\(\)/.test(l));
  // The definition of ssm_read, the tail of ssm_apply, and the lock release in finish().
  assert.equal(sends.length, 3, sends.map(([n, l]) => `${n}: ${l}`).join('\n'));
  assert.ok(sends.some(([, l]) => /^ssm_read\(\) \{ ssm_send "\$@"; \}$/.test(l)));
  assert.ok(sends.some(([, l]) => /ssm_send lock-release/.test(l)));
  const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const reads = [...code.matchAll(/ssm_read (\S+) /g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reads)], ['status'], 'the only read-only command is the status read');
  const applies = [...code.matchAll(/ssm_apply (\S+) /g)].map((m) => m[1]);
  assert.deepEqual(applies.sort(), ['backup', 'deploy', 'lock-take', 'static', 'unlock']);
  // And the status script changes nothing: it reads files and probes the flock.
  const status = src.slice(src.indexOf('remote_status() {'), src.indexOf('remote_lock_take() {'));
  assert.doesNotMatch(status, /\brm\b|>>|install |mkdir|printf '%s\\n' "\$LOCK_LINE" >/);
});

test('the lock is taken before the backup, the backup before the deploy, the consoles and health after it', () => {
  const at = (s: string) => { const i = src.indexOf(s); assert.ok(i > 0, `ship.sh has no "${s}"`); return i; };
  const order = [at('ssm_apply lock-take'), at('ssm_apply backup'), at('ssm_apply deploy'), at('ssm_apply static'), at('gate health ok')];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(src, /SHIP_LOCK=\/run\/lock\/raw-host-ship\.lock/);
  assert.match(src, /DEPLOY_LOCK=\/run\/lock\/raw-host-deploy\.lock/, 'the flock deploy.sh and Alembic\'s deploy-sha.sh take');
  assert.match(readFileSync(join(ROOT, 'infra/aws/deploy.sh'), 'utf8'), /\/run\/lock\/raw-host-deploy\.lock/);
});

test('the migration rehearsal starts from the deployed commit, runs this commit twice, and stops its database by PID', () => {
  const d = src.slice(src.indexOf('rehearse() {'), src.indexOf('run_gate "migrations forward"'));
  const steps = ['cd "$BASE_WT" && "${menv[@]}" pnpm db:migrate', 'pnpm db:seed', 'cd "$HEAD_WT" && "${menv[@]}" pnpm db:migrate', 'a second db:migrate must apply nothing', 'pnpm db:validate'];
  const idx = steps.map((s) => d.indexOf(s));
  assert.ok(idx.every((i) => i > 0), `missing a step: ${idx}`);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  // The same shape each box's migrate unit has, so a block for the other database is never applied.
  assert.match(d, /SKIP_TARGETS=main/);
  assert.match(d, /SKIP_TARGETS=formula DB_APP_ROLE=ship_app/);
  assert.match(read('infra/aws/env/render-env.sh'), /^SKIP_TARGETS=formula$/m);
  assert.match(read('infra/aws/env/render-env.sh'), /^SKIP_TARGETS=main$/m);
  // It runs because the schema changed (touched-tests.mjs `migrations`), or because it was asked for.
  assert.match(src, /if \[ "\$MIGRATIONS" = 1 \] \|\| \[ "\$FORCE_MIG" = 1 \]; then/);
  // The throwaway cluster: never adopted, stopped by PID on every exit, never by name.
  assert.match(src, /port \$PG_PORT is already listening and this run did not start it/);
  const finish = src.slice(src.indexOf('finish() {'), src.indexOf('trap finish EXIT'));
  assert.match(finish, /pg_stop/);
  assert.match(src, /pg_ctl" -D "\$PGDATA" -m immediate -w -t 30 stop > \/dev\/null 2>&1 \|\| kill "\$PG_PID"/);
});

function read(p: string) { return readFileSync(join(ROOT, p), 'utf8'); }

test('DEPLOY_AWS.md tells the operator about ship.sh, the lock and the override', () => {
  const doc = read('infra/aws/DEPLOY_AWS.md');
  assert.match(doc, /## 7a\. `infra\/aws\/ship\.sh`/);
  assert.match(doc, /\/run\/lock\/raw-host-ship\.lock/);
  assert.match(doc, /ship\.sh --unlock/);
  assert.match(doc, /fast-proof-always\.txt/);
});
