/* Sneakernet relay CLI — the human-carried air-gap crossing. Export a signed package to a FILE on
 * one console, physically carry it (USB / secure copy), import it on the other console. The two
 * databases never connect; this file is the only thing that crosses.
 *
 *   node scripts/relay-cli.cjs export <direction> <outfile> [--peek]   (--peek = don't advance cursor)
 *   node scripts/relay-cli.cjs import <infile>
 *   node scripts/relay-cli.cjs status
 *
 * Base URL: RELAY_BASE env (defaults to the Render api). Creds: RELAY_IDENTIFIER/RELAY_PASSWORD env,
 * else BOOTSTRAP_OWNER_* from .env. In a real two-console deploy each side has its own RELAY_BASE. */
const fs = require('fs');
const path = require('path');
function loadEnv() {
  const env = {};
  try {
    fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
      if (l && !l.startsWith('#') && l.includes('=')) { const i = l.indexOf('='); env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"|"$/g, ''); }
    });
  } catch {}
  return env;
}
const env = loadEnv();
const BASE = process.env.RELAY_BASE || env.RELAY_BASE || 'https://raw-aroma-api.onrender.com';
const IDENT = process.env.RELAY_IDENTIFIER || env.BOOTSTRAP_OWNER_EMAIL;
const PASS = process.env.RELAY_PASSWORD || env.BOOTSTRAP_OWNER_PASSWORD;
let TOKEN = null;

async function api(p, opts = {}) {
  const r = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function login() {
  const { j } = await api('/auth/login', { method: 'POST', body: { identifier: IDENT, password: PASS } });
  TOKEN = j && j.data && j.data.accessToken;
  if (!TOKEN) throw new Error('login failed — check RELAY_IDENTIFIER / RELAY_PASSWORD');
}

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  await login();
  if (cmd === 'export') {
    const direction = a1;
    const outfile = a2 || 'relay-package.json';
    const commit = !process.argv.includes('--peek');
    const { status, j } = await api('/v1/relay/export', { method: 'POST', body: { direction, commit } });
    if (status >= 400) { console.error('export failed', status, JSON.stringify(j && j.error)); process.exit(1); }
    fs.writeFileSync(outfile, JSON.stringify(j.data, null, 2));
    console.log(`exported ${j.data.manifest.eventCount} event(s) → ${outfile} (committed=${j.data.committed})`);
  } else if (cmd === 'import') {
    const pkg = JSON.parse(fs.readFileSync(a1, 'utf8'));
    const { status, j } = await api('/v1/relay/import', { method: 'POST', body: pkg });
    if (status >= 400) { console.error('import failed', status, JSON.stringify(j && j.error)); process.exit(1); }
    console.log('imported:', JSON.stringify(j.data));
  } else if (cmd === 'status') {
    const { j } = await api('/v1/relay/status');
    console.log(JSON.stringify(j.data, null, 2));
  } else {
    console.log('usage: relay-cli.cjs export <direction> <outfile> [--peek] | import <infile> | status');
    console.log('directions: online-to-offline | offline-to-online');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
