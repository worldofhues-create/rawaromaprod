// VAULT-FIT: infra/aws/deploy.sh on the vault box AS IT IS, run for real against a throwaway checkout.
//
// On 14 Nov 2026 the vault deploy of 7751d6da died at "env: '/usr/bin/pnpm': No such file or
// directory" (exit 127), after `git checkout` had already put the new commit under vault-api.service,
// which runs TypeScript straight from that checkout. The box modelled here is the one the lead read:
//   - no node and no pnpm in /usr/bin; both only in /opt/node-v22.12.0/bin;
//   - sudo resets PATH to its secure_path, so a `#!/usr/bin/env node` pnpm cannot start under it
//     unless the caller puts node's directory on PATH;
//   - the API unit runs the checkout's source, so what matters at every restart is which commit the
//     checkout holds, whether its dependencies were installed for that commit, and whether that
//     commit's migrations ran;
//   - up to 3f6a198 web/admin/.next was TRACKED, and an old build left it modified in the checkout.
// systemctl, systemd-run and curl are stubs that record that state at each call. git and node are real.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(ROOT, 'infra/aws/deploy.sh');
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function file(path: string, body: string, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
}

interface Box { pnpm?: 'opt' | 'none'; node?: 'opt' | 'none'; failInstall?: boolean; failMigrate?: boolean; failHealthOnNew?: boolean }

function box(o: Box = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-fit-'));
  dirs.push(dir);
  const sys = join(dir, 'usr-bin');          // stands for /usr/bin: system tools, no node, no pnpm
  const opt = join(dir, 'opt');               // stands for /opt
  const nodeBin = join(opt, 'node-v22.12.0/bin');
  const app = join(dir, 'srv/rawprod/app');
  const etc = join(dir, 'etc');
  const log = join(dir, 'calls');
  [sys, app, etc].forEach((d) => mkdirSync(d, { recursive: true }));
  writeFileSync(log, '');

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(app, 'init', '--quiet');
  file(join(app, 'scripts/migrations/0001.sql'), '-- one\n', 0o644);
  file(join(app, 'web/admin/.next/BUILD_ID'), 'built-in-git\n', 0o644);
  git(app, 'add', '.');
  git(app, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'october');
  const first = git(app, 'rev-parse', 'HEAD');
  git(app, 'rm', '--quiet', '-r', 'web/admin');
  file(join(app, 'scripts/migrations/0002.sql'), '-- two\n', 0o644);
  git(app, 'add', '.');
  git(app, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'november');
  const second = git(app, 'rev-parse', 'HEAD');
  git(app, 'checkout', '--quiet', '--detach', first);
  // origin: a bare copy here, so `git fetch --all` on the box has somewhere real to go.
  execFileSync('git', ['clone', '--quiet', '--bare', app, join(dir, 'origin.git')]);
  git(app, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  // An old deploy's `pnpm -r build` left the tracked build output modified.
  writeFileSync(join(app, 'web/admin/.next/BUILD_ID'), 'rebuilt-on-the-box\n');
  // What dependencies the running tree was installed for.
  file(join(app, 'node_modules/.installed-for'), `${first}\n`, 0o644);

  if (o.node !== 'none') {
    mkdirSync(nodeBin, { recursive: true });
    symlinkSync(process.execPath, join(nodeBin, 'node'));
  }
  if (o.pnpm !== 'none') {
    // A real `#!/usr/bin/env node` script, as pnpm is: it cannot start unless node is on PATH.
    file(join(nodeBin, 'pnpm'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), cp = require('child_process');
const a = process.argv.slice(2);
let cwd = process.cwd(); const c = a.indexOf('-C'); if (c >= 0) { cwd = a[c + 1]; a.splice(c, 2); }
const head = () => cp.execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.appendFileSync(${JSON.stringify(log)}, 'pnpm ' + a.join(' ') + ' @' + (a[0] === '--version' ? '-' : head().slice(0, 8)) + ' in ' + path.basename(cwd) + '\\n');
if (a[0] === '--version') { console.log('10.34.5'); process.exit(0); }
if (a[0] === 'install') {
  if (${o.failInstall ? 'true' : 'false'}) { console.error('ERR_PNPM_FETCH_404'); process.exit(1); }
  fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'node_modules/.installed-for'), head() + '\\n');
}
if (a[0] === 'db:migrate') {
  if (${o.failMigrate ? 'true' : 'false'}) { console.error('migration 0002 failed'); process.exit(1); }
  if (process.env.FORMULA_DATABASE_URL !== 'postgres://vault-owner/vault') { console.error('not the migrate env'); process.exit(2); }
  fs.appendFileSync(${JSON.stringify(join(dir, 'ledger'))}, head() + '\\n');
}
`);
  }

  // sudo as Ubuntu's: PATH becomes secure_path (here: the stand-in /usr/bin plus the real system
  // dirs git needs). `env PATH=...` after it is honoured, because env runs inside.
  file(join(sys, 'sudo'), `#!/bin/bash
echo "sudo $*" >> "${log}"
[ "$1" = -u ] && shift 2
exec /usr/bin/env -i HOME="${dir}" PATH="${sys}:/usr/bin:/bin" "$@"
`);
  // The API unit runs the checkout's source: a restart starts whatever $APP holds.
  const state = `h=$(git -C "${app}" rev-parse HEAD 2>/dev/null | cut -c1-8); d=$(cut -c1-8 "${app}/node_modules/.installed-for" 2>/dev/null); m=$(grep -c "^$(git -C "${app}" rev-parse HEAD 2>/dev/null)" "${dir}/ledger" 2>/dev/null || echo 0)`;
  file(join(sys, 'systemctl'), `#!/bin/bash
${state}
case "$1" in
  restart) echo "systemctl restart $2 app=$h deps=$d migrated=$m" >> "${log}" ;;
  is-active) exit 0 ;;
  *) echo "systemctl $*" >> "${log}" ;;
esac
`);
  file(join(sys, 'systemd-run'), `#!/bin/bash
echo "systemd-run $*" >> "${log}"
wd=""; envf=""; user=""; path=""
while [ $# -gt 0 ]; do case "$1" in
  -p) case "$2" in WorkingDirectory=*) wd=\${2#*=};; EnvironmentFile=*) envf=\${2#*=};; User=*) user=\${2#*=};; esac; shift 2;;
  --setenv=PATH=*) path=\${1#--setenv=PATH=}; shift;;
  --*) shift;;
  *) break;;
esac; done
cd "$wd" || exit 1
set -a; . "$envf"; set +a
exec /usr/bin/env PATH="$path" "$@"
`);
  file(join(sys, 'curl'), `#!/bin/bash
${state}
[ "${o.failHealthOnNew ? '1' : ''}" = 1 ] && [ "$h" = "${second.slice(0, 8)}" ] && { printf 502; exit 0; }
printf 200
`);
  file(join(sys, 'sleep'), '#!/bin/bash\n');
  file(join(sys, 'flock'), '#!/bin/bash\nexit 0\n');
  file(join(sys, 'psql'), "#!/bin/bash\nprintf '%s\\n' 0001.sql\n");
  writeFileSync(join(etc, 'vault-migrate.env'), 'FORMULA_DATABASE_URL=postgres://vault-owner/vault\nSKIP_TARGETS=main\n');
  writeFileSync(join(etc, 'previous-sha'), `${first}\n`);
  writeFileSync(join(dir, 'srv/rawprod/DEPLOYED_SHA'), `${first}\n`);
  writeFileSync(join(dir, 'meminfo'), `MemTotal: 1879000 kB\nMemAvailable: ${958 * 1024} kB\n`);

  const env = {
    PATH: `${sys}:/usr/bin:/bin`,           // root's PATH on the box: no node, no pnpm
    HOME: dir,
    RAWPROD_ROLE: 'vault',
    RAWPROD_APP_DIR: app,
    RAWPROD_STATE_DIR: etc,
    RAWPROD_STATE_FILE_DIR: join(dir, 'srv/rawprod'),
    RAWPROD_HOST_LOCK: join(dir, 'host.lock'),
    RAWPROD_MEMINFO: join(dir, 'meminfo'),
    RAWPROD_OPT_DIR: opt,
    RAWPROD_RUN_USER: 'rawprod',
  };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync('/bin/bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const lines = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    dir, app, first, second, run, lines,
    head: () => git(app, 'rev-parse', 'HEAD'),
    deployed: () => readFileSync(join(dir, 'srv/rawprod/DEPLOYED_SHA'), 'utf8').trim(),
    stages: () => execFileSync('ls', ['-a', join(dir, 'srv/rawprod')], { encoding: 'utf8' }).split('\n').filter((n) => n.startsWith('.stage-')),
  };
}

const f8 = (s: string) => s.slice(0, 8);

test('on the vault box as it is (pnpm and node only under /opt, sudo resets PATH) the deploy finds them and goes green', () => {
  const b = box();
  const r = b.run([b.second]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /tools: node v22\.\S+ \(.*opt\/node-v22\.12\.0\/bin\), pnpm 10\.34\.5/);
  assert.match(r.out, /DEPLOYED/);
  assert.equal(b.head(), b.second);
  assert.equal(b.deployed(), b.second);
  assert.equal(existsSync(`${b.app}.prev`), false, 'the old tree is removed once green');
  assert.deepEqual(b.stages(), []);
});

test('the running service is never restarted onto code whose dependencies and migrations are not in place', () => {
  const b = box();
  assert.equal(b.run([b.second]).code, 0);
  const l = b.lines();
  const at = (re: RegExp) => { const i = l.findIndex((x) => re.test(x)); assert.ok(i >= 0, `${re} not in:\n${l.join('\n')}`); return i; };
  const install = at(/^pnpm install --frozen-lockfile @\w+ in \.stage-/);
  const build = at(/^pnpm -r --workspace-concurrency=1 .* build @\w+ in \.stage-/);
  const migrate = at(/^systemd-run .*WorkingDirectory=.*\.stage-.*EnvironmentFile=.*vault-migrate\.env/);
  const apiRestart = at(/^systemctl restart vault-api\.service/);
  assert.ok(install < build && build < migrate && migrate < apiRestart, l.join('\n'));
  // The one restart of the API: on the new commit, installed for it, migrated for it.
  const restarts = l.filter((x) => x.startsWith('systemctl restart vault-api.service'));
  assert.deepEqual(restarts, [`systemctl restart vault-api.service app=${f8(b.second)} deps=${f8(b.second)} migrated=1`]);
  // Nothing ran in the live checkout: no install, no build, no checkout there.
  assert.equal(l.filter((x) => /^pnpm (install|-r)/.test(x) && / in app$/.test(x)).length, 0, l.join('\n'));
});

test('tracked web/admin/.next left modified by an old build neither blocks the deploy nor reaches the new tree', () => {
  const b = box();
  assert.match(execFileSync('git', ['-C', b.app, 'status', '--porcelain'], { encoding: 'utf8' }), /web\/admin\/\.next\/BUILD_ID/);
  const r = b.run([b.second]);
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(join(b.app, 'web/admin')), false);
  assert.equal(execFileSync('git', ['-C', b.app, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }), '');
  assert.equal(execFileSync('git', ['-C', b.app, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(), join(b.dir, 'origin.git'),
    'the new tree fetches from where the old one did');
});

test('no pnpm anywhere: refused before anything is cloned, installed or restarted', () => {
  const b = box({ pnpm: 'none' });
  const r = b.run([b.second]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no pnpm on this host .*Nothing was changed/);
  assert.equal(b.head(), b.first);
  assert.deepEqual(b.stages(), []);
  assert.equal(b.lines().filter((x) => /^systemctl restart|^systemd-run/.test(x)).length, 0);
});

test('a pnpm that exists but cannot run (no node 22 to start it) is refused the same way: the 14 Nov failure', () => {
  const b = box({ node: 'none' });
  const r = b.run([b.second], { RAWPROD_PNPM: join(b.dir, 'opt/node-v22.12.0/bin/pnpm'), RAWPROD_NODE_BIN: join(b.dir, 'usr-bin') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no node 22|does not run as rawprod/);
  assert.equal(b.head(), b.first);
  assert.equal(b.lines().filter((x) => /^systemctl restart|^systemd-run/.test(x)).length, 0);
});

for (const [name, opt, says] of [
  ['the install fails', { failInstall: true }, /pnpm install failed in the stage/],
  ['the migrations fail', { failMigrate: true }, /migrations failed/],
] as const) {
  test(`${name}: the live checkout stays at the old commit, nothing is restarted, the stage is gone`, () => {
    const b = box(opt);
    const r = b.run([b.second]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, says);
    assert.match(r.out, new RegExp(`is untouched at ${b.first.slice(0, 12)} and vault-api\\.service was not restarted`));
    assert.equal(b.head(), b.first);
    assert.equal(readFileSync(join(b.app, 'node_modules/.installed-for'), 'utf8').trim(), b.first, 'the running tree keeps its own dependencies');
    assert.equal(b.deployed(), b.first);
    assert.deepEqual(b.stages(), []);
    assert.equal(b.lines().filter((x) => x.startsWith('systemctl restart')).length, 0, b.lines().join('\n'));
  });
}

test('health fails on the new commit: the old tree is swapped back, restarted and checked; nothing is recorded', () => {
  const b = box({ failHealthOnNew: true });
  const r = b.run([b.second]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /HEALTH CHECK FAILED on [0-9a-f]{40}\. Putting [0-9a-f]{12} back/);
  assert.match(r.out, /RETURNED TO [0-9a-f]{12}: vault-api\.service runs it again and answers/);
  assert.equal(b.head(), b.first);
  assert.equal(b.deployed(), b.first);
  const restarts = b.lines().filter((x) => x.startsWith('systemctl restart vault-api.service'));
  assert.deepEqual(restarts, [
    `systemctl restart vault-api.service app=${f8(b.second)} deps=${f8(b.second)} migrated=1`,
    `systemctl restart vault-api.service app=${f8(b.first)} deps=${f8(b.first)} migrated=0`,
  ]);
  assert.equal(existsSync(`${b.app}.failed`), true, 'the failed tree is kept for reading');
});

test('too little disk to stage: refused before anything is written', () => {
  const b = box();
  const r = b.run([b.second], { RAWPROD_MIN_FREE_MB: '999999999' });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not enough disk to stage .*Nothing was changed/);
  assert.equal(b.head(), b.first);
  assert.deepEqual(b.stages(), []);
});

test('the main role keeps the in-place path that deployed 7751d6da green, unless told to stage', () => {
  const s = readFileSync(SCRIPT, 'utf8');
  assert.match(s, /^STAGED="\$\{RAWPROD_STAGED:-\$\(\[ "\$ROLE" = vault \] && echo 1 \|\| echo 0\)\}"$/m);
  assert.doesNotMatch(s, /^PNPM="\$\{RAWPROD_PNPM:-\/usr\/bin\/pnpm\}"/m, 'no host path is assumed');
});
