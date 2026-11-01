/* Stops exactly the processes this harness started, by the ids it recorded. Nothing by name. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUN } from './config.mjs';

for (const name of ['api', 'vault-api', 'consoles']) {
  const f = join(RUN, `${name}.pid`);
  if (!existsSync(f)) continue;
  const pid = Number(readFileSync(f, 'utf8'));
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  rmSync(f);
}
const pgdata = join(RUN, 'pg');
if (process.env.BS_PG_EXTERNAL !== '1' && existsSync(join(pgdata, 'postmaster.pid'))) {
  const bin = process.env.BS_PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
  execFileSync(join(bin, 'pg_ctl'), ['-D', pgdata, '-m', 'fast', 'stop'], { stdio: 'ignore' });
}
console.log('stack down');
