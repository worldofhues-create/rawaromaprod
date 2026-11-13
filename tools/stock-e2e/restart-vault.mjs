// Restart RawProd's main API with the env the running one has, plus extra KEY=VALUE args. Prints nothing secret.
import { execFileSync, spawn } from 'node:child_process';
import { openSync, writeFileSync, readFileSync } from 'node:fs';
const [run, repo, ...extra] = process.argv.slice(2);
const pid = readFileSync(`${run}/vault-api.pid`, 'utf8').trim();
const raw = execFileSync('ps', ['eww', '-p', pid], { encoding: 'utf8' }).split('\n')[1];
const env = {};
for (const m of raw.matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(\S*)/g)) env[m[1]] = m[2];
for (const kv of extra) { const i = kv.indexOf('='); env[kv.slice(0, i)] = kv.slice(i + 1); }
env.PATH = process.env.PATH; env.HOME = process.env.HOME;
process.kill(Number(pid));
await new Promise((r) => setTimeout(r, 3000));
const l = openSync(`${run}/vault-api.log`, 'a');
const child = spawn('node', ['--import', '@swc-node/register/esm-register', 'src/vault-main.ts'], { cwd: `${repo}/backend/api`, env, stdio: ['ignore', l, l], detached: true });
child.unref(); writeFileSync(`${run}/vault-api.pid`, String(child.pid));
for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${process.env.SE2E_RP_VAULT_PORT || 4362}/health`)).ok) { console.log('vault-api restarted', Object.keys(env).length, 'vars'); process.exit(0); } } catch {} await new Promise((r) => setTimeout(r, 1000)); }
console.log('api did not come back'); process.exit(1);
