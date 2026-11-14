// HOST-LOCK-1: runs infra/aws/deploy.sh for real against a throwaway checkout. On 2026-11-07 this
// script's build and Alembic's ran together on a 3.8 GB no-swap box and the kernel killed Alembic's.
// sudo, systemctl, curl, psql, pnpm and sleep are stubbed. flock is too, because macOS has no
// flock(1), but the stub takes a real flock(2) on the descriptor the script opened, so the exclusion
// below is the kernel's and not a simulation.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

function host(availableMb: number | null = 2000) {
  const dir = mkdtempSync(join(tmpdir(), 'host-lock-'));
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
  stub(bin, 'pnpm', `echo "pnpm $*" >> "${calls}"`);
  stub(bin, 'systemctl', `echo "systemctl $*" >> "${calls}"`);
  // VAULT-FIT: the vault role migrates from its staged tree through systemd-run.
  stub(bin, 'systemd-run', `echo "systemd-run $*" >> "${calls}"`);
  stub(bin, 'curl', 'printf 200');
  stub(bin, 'psql', "printf '%s\\n' 0001.sql");
  stub(bin, 'sleep', '');
  stub(bin, 'flock', `exec python3 -c '
import fcntl, sys
try: fcntl.flock(int(sys.argv[2]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError: sys.exit(1)
' "$@"`);
  writeFileSync(join(etc, 'migrate.env'), 'DATABASE_URL=postgres://stub/db\n');
  writeFileSync(join(etc, 'vault-migrate.env'), 'DATABASE_URL=postgres://stub/db\n');
  writeFileSync(join(etc, 'previous-sha'), `${first}\n`);
  const meminfo = join(dir, 'meminfo');
  writeFileSync(meminfo, availableMb === null ? 'MemTotal: 3916000 kB\n' : `MemTotal: 3916000 kB\nMemAvailable: ${availableMb * 1024} kB\n`);

  const lock = join(dir, 'host.lock');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RAWPROD_APP_DIR: app,
    RAWPROD_STATE_DIR: etc,
    RAWPROD_STATE_FILE_DIR: dir,
    RAWPROD_PNPM: join(bin, 'pnpm'),
    RAWPROD_HOST_LOCK: lock,
    RAWPROD_MEMINFO: meminfo,
  };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { dir, app, lock, first, second, run, head: () => git('rev-parse', 'HEAD'), calls: () => readFileSync(calls, 'utf8') };
}

/** Another deploy, the way Alembic's holds it: flock on the shared file, and a line saying who. */
async function holdLock(lock: string) {
  const holder = spawn('python3', ['-c', `
import fcntl, sys, time
f = open(sys.argv[1], 'a')
fcntl.flock(f, fcntl.LOCK_EX)
f.write('alembic pid 42 since then\\n'); f.flush()
print('held', flush=True)
time.sleep(60)
`, lock], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  return holder;
}

test('a deploy refuses while another deploy holds the host lock, and names the holder', async () => {
  const h = host();
  const holder = await holdLock(h.lock);
  try {
    const r = h.run([h.second]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /another deploy holds the host lock: alembic pid 42/);
    assert.equal(h.head(), h.first, 'nothing may be checked out');
    assert.doesNotMatch(h.calls(), /fetch|pnpm|systemctl/);
  } finally {
    holder.kill();
  }
});

test('a rollback refuses under the same lock', async () => {
  const h = host();
  const holder = await holdLock(h.lock);
  try {
    const r = h.run(['--rollback']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /another deploy holds the host lock/);
    assert.doesNotMatch(h.calls(), /pnpm|systemctl/);
  } finally {
    holder.kill();
  }
});

test('--status reads through a held lock', async () => {
  const h = host();
  const holder = await holdLock(h.lock);
  try {
    assert.equal(h.run(['--status']).code, 0);
  } finally {
    holder.kill();
  }
});

test('the lock is free again after a deploy ends, and the file says who last had it', () => {
  const h = host();
  const r = h.run([h.second]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DEPLOYED/);
  assert.equal(h.head(), h.second);
  assert.match(readFileSync(h.lock, 'utf8'), /^rawprod pid \d+ since /m);
  assert.equal(h.run([h.second]).code, 0, 'a second deploy must get the lock');
});

test('below the floor nothing is checked out, installed or built', () => {
  const h = host(1799);
  const r = h.run([h.second]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not enough memory to build: 1799MB available, 1800MB required/);
  assert.equal(h.head(), h.first);
  assert.doesNotMatch(h.calls(), /pnpm|systemctl/);
});

test('exactly on the floor builds, and the floor can be set for the host', () => {
  const h = host(1800);
  assert.equal(h.run([h.second]).code, 0);
  const low = host(1000);
  assert.equal(low.run([low.second], { RAWPROD_MIN_BUILD_MEM_MB: '900' }).code, 0);
});

test('a rollback rebuilds, so it meets the floor too', () => {
  const h = host(1000);
  const r = h.run(['--rollback']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not enough memory to build/);
});

test('memory that cannot be read refuses rather than passes', () => {
  const h = host(null);
  const r = h.run([h.second]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /cannot read available memory/);
  assert.equal(h.head(), h.first);
});

// t4g.small, 1.8 GiB, about 1.4 GiB available (infra/aws/PROVISIONED.md). The main host's 1800 could
// never pass there, and nothing shares that box's build.
test('the vault host is not held to the main host\'s floor', () => {
  const h = host(1400);
  const r = h.run([h.second], { RAWPROD_ROLE: 'vault' });
  assert.equal(r.code, 0, r.out);
  const set = host(1400);
  assert.match(set.run([set.second], { RAWPROD_ROLE: 'vault', RAWPROD_MIN_BUILD_MEM_MB: '1500' }).out, /not enough memory/);
});

test('the lock path is the one Alembic takes', () => {
  assert.match(readFileSync(SCRIPT, 'utf8'), /\/run\/lock\/raw-host-deploy\.lock/);
});
