#!/usr/bin/env node
// SHIP-RP: the evidence file infra/aws/ship.sh leaves for every run, and the reader that lets a later
// run trust an earlier one.
//
// ship.sh writes what it did as plain files in its work directory (meta, gates.tsv, notes, selection.json)
// because bash cannot be trusted to quote JSON. This turns them into one sealed ship.json:
//
//   write  --work <dir> --out <file>            build ship.json from the work directory
//   verify <file>                               exit 0 if the seal matches the content
//   find-proof --dir <evidence/<sha>> --sha <full> --base <full> --role main|vault --tool <sha256> [--max-age-hours 24]
//                                               print the newest ship.json whose LOCAL proof passed for
//                                               exactly this commit, base, role and ship.sh; nothing if none
//   last-deployed --root <evidence> --role main|vault
//                                               print the commit of the newest sealed run that ended
//                                               DEPLOYED GREEN or ROLLED BACK GREEN on that box; nothing
//                                               if none. A dry run makes no AWS call, so this is how it
//                                               knows what production runs when nobody tells it
//
// The seal is a sha256 over the content. It is not a signature: it catches an evidence file edited after
// the fact, not an operator who rewrites it on purpose. "One proof per commit" rests on it: an --apply
// straight after a dry run reuses the dry run's proof and does not build and test the same commit twice.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'rawprod-ship/1';
/** The gates that make up the local proof. A proof is reusable only if every one of them is ok or skipped. */
export const LOCAL_GATES = ['pushed commit', 'install', 'typecheck', 'build', 'touched tests', 'migrations forward', 'tree unchanged'];

export const seal = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

export function build({ meta, gates, notes, selection }) {
  const local = LOCAL_GATES.map((name) => gates.find((g) => g.name === name));
  const localOk = local.every((g) => g && (g.status === 'ok' || g.status === 'skipped'));
  const body = { schema: SCHEMA, ...meta, local_proof: meta.local_proof ?? (localOk ? 'ok' : 'incomplete'), gates, notes, selection };
  return { ...body, seal: seal(body) };
}

export function verify(doc) {
  if (!doc || doc.schema !== SCHEMA || typeof doc.seal !== 'string') return false;
  const { seal: have, ...body } = doc;
  return seal(body) === have;
}

export function isReusableProof(doc, { sha, base, role, tool, maxAgeHours = 24, now = Date.now() }) {
  if (!verify(doc)) return false;
  if (doc.sha !== sha || doc.base !== base || doc.role !== role || doc.ship_sh_sha256 !== tool) return false;
  if (doc.local_proof !== 'ok') return false;
  const age = now - Date.parse(doc.finished);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeHours * 3600 * 1000;
}

/** The commit this laptop last saw go green on a box. Not the box's word: --apply asks the box. */
export function lastDeployed(root, role) {
  if (!root || !existsSync(root)) return '';
  let best = null;
  for (const sha of readdirSync(root)) {
    let runs = [];
    try { runs = readdirSync(join(root, sha)); } catch { continue; }
    for (const run of runs) {
      const file = join(root, sha, run, 'ship.json');
      if (!existsSync(file)) continue;
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        if (!verify(doc) || doc.role !== role) continue;
        if (!/^(DEPLOYED GREEN|ROLLED BACK GREEN)/.test(String(doc.verdict))) continue;
        if (!/^[0-9a-f]{40}$/.test(String(doc.sha))) continue;
        if (!best || String(doc.finished) > String(best.finished)) best = doc;
      } catch { /* half written, or not ours: says nothing */ }
    }
  }
  return best ? best.sha : '';
}

function readWork(work) {
  const lines = (f) => (existsSync(join(work, f)) ? readFileSync(join(work, f), 'utf8').split('\n').filter(Boolean) : []);
  const meta = {};
  for (const l of lines('meta')) {
    const i = l.indexOf('=');
    if (i > 0) meta[l.slice(0, i)] = l.slice(i + 1);
  }
  const gates = lines('gates.tsv').map((l) => {
    const [name, status, seconds, detail = ''] = l.split('\t');
    return { name, status, seconds: Number(seconds), detail };
  });
  let selection = null;
  if (existsSync(join(work, 'selection.json'))) {
    try { selection = JSON.parse(readFileSync(join(work, 'selection.json'), 'utf8')); } catch { selection = null; }
  }
  return { meta, gates, notes: lines('notes'), selection };
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const o = args(rest);
  if (cmd === 'write') {
    const doc = build(readWork(o.work));
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, `${JSON.stringify(doc, null, 1)}\n`, { mode: 0o600 });
    return 0;
  }
  if (cmd === 'verify') {
    const ok = verify(JSON.parse(readFileSync(o._[0], 'utf8')));
    process.stdout.write(ok ? 'sealed\n' : 'SEAL DOES NOT MATCH\n');
    return ok ? 0 : 1;
  }
  if (cmd === 'find-proof') {
    if (!existsSync(o.dir)) return 0;
    const found = [];
    for (const run of readdirSync(o.dir)) {
      const file = join(o.dir, run, 'ship.json');
      if (!existsSync(file)) continue;
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8'));
        if (isReusableProof(doc, { sha: o.sha, base: o.base, role: o.role, tool: o.tool, maxAgeHours: Number(o['max-age-hours'] ?? 24) })) found.push([doc.finished, file]);
      } catch { /* not ours, or half written: not a proof */ }
    }
    found.sort();
    if (found.length) process.stdout.write(`${found[found.length - 1][1]}\n`);
    return 0;
  }
  if (cmd === 'last-deployed') {
    const sha = lastDeployed(o.root, o.role);
    if (sha) process.stdout.write(`${sha}\n`);
    return 0;
  }
  process.stderr.write('usage: ship-evidence.mjs write|verify|find-proof|last-deployed ...\n');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
