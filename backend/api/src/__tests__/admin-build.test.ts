// ADMIN-BUILD: `|| say "(no-op or non-fatal...)"` turned every failed or OOM-killed build into a
// deploy. Runs infra/aws/deploy.sh for real against a throwaway checkout; sudo, systemctl, curl,
// psql, pnpm, sleep and flock are stubbed the way host-lock.test.ts stubs them.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(ROOT, 'infra/aws/deploy.sh');
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function host(buildExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-build-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const app = join(dir, 'app');
  const etc = join(dir, 'etc');
  const calls = join(dir, 'calls');
  [bin, app, etc].forEach((d) => mkdirSync(d));
  writeFileSync(calls, '');

  const git = (...args: string[]) => execFileSync('git', ['-C', app, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  mkdirSync(join(app, 'scripts/migrations'), { recursive: true });
  writeFileSync(join(app, 'scripts/migrations/0001.sql'), '-- one\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'second');
  const second = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--detach', first);

  stub(bin, 'sudo', `echo "sudo $*" >> "${calls}"\nwhile [[ "$1" == -* || "$1" == rawprod || "$1" == env || "$1" == *=* ]]; do shift; done\nexec "$@"`);
  stub(bin, 'pnpm', `echo "pnpm $*" >> "${calls}"\nif [[ " $* " == *" build "* ]]; then echo "tsc: the compiler said why"; exit ${buildExit}; fi`);
  stub(bin, 'systemctl', `echo "systemctl $*" >> "${calls}"`);
  stub(bin, 'curl', 'printf 200');
  stub(bin, 'psql', "printf '%s\\n' 0001.sql");
  stub(bin, 'sleep', '');
  stub(bin, 'flock', 'exit 0');
  writeFileSync(join(etc, 'migrate.env'), 'DATABASE_URL=postgres://stub/db\n');
  writeFileSync(join(etc, 'vault-migrate.env'), 'DATABASE_URL=postgres://stub/db\n');
  writeFileSync(join(etc, 'previous-sha'), `${first}\n`);
  writeFileSync(join(dir, 'DEPLOYED_SHA'), `${first}\n`);
  writeFileSync(join(dir, 'meminfo'), `MemAvailable: ${4000 * 1024} kB\n`);

  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RAWPROD_APP_DIR: app,
    RAWPROD_STATE_DIR: etc,
    RAWPROD_STATE_FILE_DIR: dir,
    RAWPROD_PNPM: join(bin, 'pnpm'),
    RAWPROD_HOST_LOCK: join(dir, 'host.lock'),
    RAWPROD_MEMINFO: join(dir, 'meminfo'),
  };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { first, second, run, calls: () => readFileSync(calls, 'utf8'), deployed: () => readFileSync(join(dir, 'DEPLOYED_SHA'), 'utf8').trim() };
}

function refusesAfterFailedBuild(h: ReturnType<typeof host>, r: { code: number | null; out: string }) {
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /FATAL: build failed/);
  assert.doesNotMatch(r.out, /no-op or non-fatal|DEPLOYED|ROLLED BACK/);
  assert.doesNotMatch(h.calls(), /systemctl restart/, 'no migration or restart after a failed build');
  assert.equal(h.deployed(), h.first, 'a failed build must not be recorded as deployed');
}

test('a failed build stops the deploy before migrations, restart or the record', () => {
  const h = host(1);
  refusesAfterFailedBuild(h, h.run([h.second]));
});

test('an OOM-killed build (exit 137) stops it too, and says what probably happened', () => {
  const h = host(137);
  const r = h.run([h.second]);
  refusesAfterFailedBuild(h, r);
  assert.match(r.out, /exit 137/);
  assert.match(r.out, /out of memory/);
});

test('the failure says what is left running, and the compiler output is not thrown away', () => {
  const h = host(1);
  const r = h.run([h.second]);
  assert.match(r.out, /tsc: the compiler said why/);
  assert.match(r.out, new RegExp(`${h.first}`), 'names the commit the API process is still running');
});

test('a rollback whose build fails is refused the same way', () => {
  const h = host(1);
  const r = h.run(['--rollback']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /FATAL: build failed/);
  assert.doesNotMatch(h.calls(), /systemctl restart/);
});

test('the vault role fails the same way', () => {
  const h = host(1);
  refusesAfterFailedBuild(h, h.run([h.second], { RAWPROD_ROLE: 'vault' }));
});

// A rollback runs THIS script against an OLDER tree, which still has web/admin (fails in 2 s) and
// @core/api's `nest build` (148 errors). The exclusions have to live here, not only in those
// packages, or every rollback past this commit would now be refused.
// Serial, because the vault box has about 970 MB available: 1321 MB at pnpm's default concurrency,
// 810 MB at one.
test('the build leaves out what nothing serves, on any tree, one package at a time', () => {
  for (const args of [(h: ReturnType<typeof host>) => [h.second], () => ['--rollback']]) {
    const h = host();
    const r = h.run(args(h));
    assert.equal(r.code, 0, r.out);
    const build = h.calls().split('\n').find((l) => l.startsWith('pnpm') && / build$/.test(l));
    assert.ok(build, h.calls());
    assert.match(build, /--filter !@core\/admin-shell/);
    assert.match(build, /--filter !@core\/api/);
    assert.match(build, /--workspace-concurrency=1/);
  }
});

test('no required step in deploy.sh is excused by a message', () => {
  assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /\|\|\s*say\b/);
});

test('web/admin is gone from the workspace, and .next can never be tracked again', () => {
  assert.equal(existsSync(join(ROOT, 'web/admin/package.json')), false);
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' });
  assert.doesNotMatch(tracked, /(^|\/)\.next\//m);
  assert.doesNotMatch(tracked, /^web\/admin\//m);
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^web\/admin\/\.next\/$/m);
  assert.doesNotMatch(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'), /^  web\/admin:$/m);
});

// `nest build` exits 1 with 148 errors and still leaves 592 compiled files beside the sources, where
// `./x.js` imports would load them instead of the .ts. It never reached the host only because
// web/admin failed first. The first deploy of this commit runs the OLD script's plain
// `pnpm -r build`, so the package itself must not have the step.
test('no workspace package has a build that writes outside its own dist', () => {
  const offenders: string[] = [];
  for (const group of ['backend', 'packages', 'web', 'mobile']) {
    for (const name of readdirSync(join(ROOT, group))) {
      const file = join(ROOT, group, name, 'package.json');
      if (!existsSync(file)) continue;
      const build = JSON.parse(readFileSync(file, 'utf8')).scripts?.build as string | undefined;
      if (build && /\bnest build\b/.test(build)) offenders.push(`${group}/${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});
