#!/usr/bin/env node
// SHIP-RP: which tests does this change touch?
//
// infra/aws/ship.sh deploys a commit after the tests the change touches, not after all 259 files. That is
// only safe if "touches" is a fixed rule that gives the same answer for the same two commits, so it is
// here as a pure function with a test per row (backend/api/src/__tests__/touched-tests.test.ts) and not
// in anybody's head. The rule, in the order it is applied to each changed path:
//
//   anything                        the always-on list (`test` lines of infra/aws/fast-proof-always.txt)
//   a `sensitive` pattern matches   the WHOLE suite (`pnpm test`): migrations, the schema, the bridge,
//                                   sign-in, stock, the vault, the test harness
//   scripts/migrations/**, scripts/db-*.ts, packages/data-*  the migration rehearsal runs (ship.sh step d)
//   *.md, docs/**                   nothing more
//   e2e/**                          nothing, and a note "e2e specs changed, not run"
//   backend/**/*.test.ts            that file
//   backend/api/src/<module>        every test that imports that module directly
//   backend/<cluster>/**, packages/<pkg>/**   every test that imports that package, by path or by name
//   any other file (web, infra, scripts, tools)   every test whose text names it, by repository path or
//                                   by file name: the console tests read their files from disk
//
// A changed source that selects no test is written into `notes` ("has no direct test"), so the evidence
// says what was not covered. Over-selection only costs time; nothing here ever removes a test.
//
//   node scripts/touched-tests.mjs --repo <checkout at head> --base <sha> --head <sha>
//        [--always infra/aws/fast-proof-always.txt] [--tests '<glob>']...
//   prints { files, fullSuite, migrations, notes, refusals, reasons } as JSON; exit 2 on a refusal.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** `**` crosses directories, `*` stays inside one. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

/**
 * infra/aws/fast-proof-always.txt:
 *   test <path>         # reason      always run
 *   sensitive <glob>    # reason      a change under it runs the whole suite
 * A line with no reason is refused: a list nobody can explain is a list nobody dares to shorten or trust.
 */
export function parseAlwaysList(text) {
  const tests = [];
  const sensitive = [];
  text.split('\n').forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const hash = line.indexOf('#');
    const reason = hash >= 0 ? line.slice(hash + 1).trim() : '';
    const [kind, target, ...rest] = (hash >= 0 ? line.slice(0, hash) : line).trim().split(/\s+/);
    if (kind !== 'test' && kind !== 'sensitive') throw new Error(`fast-proof-always line ${n + 1} is neither "test" nor "sensitive": ${line}`);
    if (!target || rest.length) throw new Error(`fast-proof-always line ${n + 1} must be "${kind} <one path>  # reason": ${line}`);
    if (!reason) throw new Error(`fast-proof-always line ${n + 1} has no reason: ${line}`);
    if (kind === 'test') tests.push({ path: target, reason });
    else sensitive.push({ glob: target, re: globToRegExp(target), reason });
  });
  return { tests, sensitive };
}

const stripExt = (p) => p.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
const isTest = (p) => /^backend\/.*\.test\.ts$/.test(p);
const isDoc = (p) => p.endsWith('.md') || p.startsWith('docs/');
/** The schema, or the thing that applies it. Step (d) of ship.sh runs when one of these changed. */
const MIGRATION_PATHS = ['scripts/migrations/**', 'scripts/db-*.ts', 'scripts/gen-schema-migrations.mjs', 'packages/data-*/**'].map(globToRegExp);

/** One test file's text, reduced to what the rule reads: [path, { text, imports, packages }]. */
export function indexTest(path, text) {
  const imports = [];
  const packages = [];
  const dir = posix.dirname(path);
  for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.')) imports.push(stripExt(posix.normalize(posix.join(dir, spec))));
    else if (!spec.startsWith('node:')) packages.push(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
  return [path, { text, imports, packages }];
}

function namesFile(text, name) {
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(name)}($|[^A-Za-z0-9_-])`).test(text);
}

/**
 * @param {{ changed: string[], deleted?: string[], index: Map<string, {text: string, imports: string[], packages: string[]}>,
 *           always: { tests: {path: string, reason: string}[], sensitive: {glob: string, re: RegExp, reason: string}[] },
 *           packages: Map<string, string>, extra?: string[] }} input
 *   `packages` maps a workspace directory ("backend/cluster-production") to its package name.
 */
export function selectTests({ changed, deleted = [], index, always, packages, extra = [] }) {
  const reasons = {};
  const notes = [];
  const refusals = [];
  let fullSuite = false;
  let migrations = false;
  const add = (file, why) => { (reasons[file] ??= []).push(why); };

  for (const t of always.tests) {
    if (deleted.includes(t.path)) refusals.push(`the change deletes the always-on test ${t.path} (${t.reason}). Take it off infra/aws/fast-proof-always.txt in a reviewed commit first, or put the test back`);
    else if (index.has(t.path)) add(t.path, `always on: ${t.reason}`);
    else notes.push(`always-on test ${t.path} is not in this commit`);
  }

  const pkgOf = (path) => {
    for (const [dir, name] of packages) if (path.startsWith(`${dir}/`)) return { dir, name };
    return null;
  };

  for (const path of [...changed, ...deleted]) {
    const hit = always.sensitive.find((s) => s.re.test(path));
    if (hit) {
      fullSuite = true;
      notes.push(`full suite: ${path} matches "${hit.glob}" (${hit.reason})`);
    }
    if (MIGRATION_PATHS.some((re) => re.test(path))) migrations = true;
  }

  for (const path of changed) {
    if (isDoc(path)) continue;
    if (path.startsWith('e2e/')) { notes.push(`e2e specs changed, not run: ${path}`); continue; }
    if (isTest(path)) {
      if (index.has(path)) add(path, 'changed');
      continue;
    }
    const pkg = pkgOf(path);
    const bare = stripExt(path);
    const name = posix.basename(path);
    let hits = 0;
    for (const [file, info] of index) {
      let why = null;
      if (info.imports.includes(bare)) why = `imports ${path}`;
      else if (pkg && pkg.dir !== 'backend/api' && (info.packages.includes(pkg.name) || info.imports.some((i) => i.startsWith(`${pkg.dir}/`)))) why = `imports ${pkg.name}, which ${path} is part of`;
      else if (info.text.includes(path)) why = `names ${path}`;
      else if (!path.startsWith('backend/') && !path.startsWith('packages/') && namesFile(info.text, name)) why = `names ${name} (${path})`;
      if (why) { add(file, why); hits++; }
    }
    if (hits === 0) {
      notes.push(pkg || path.startsWith('backend/') ? `touched tests: ${path} has no direct test` : `touched tests: ${path}: no test names it`);
    }
  }

  for (const glob of extra) {
    const re = globToRegExp(glob);
    const matched = [...index.keys()].filter((f) => re.test(f));
    if (matched.length === 0) notes.push(`--tests ${glob} matched no test`);
    for (const f of matched) add(f, `--tests ${glob}`);
  }

  return { files: Object.keys(reasons).sort(), fullSuite, migrations, notes, refusals, reasons };
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

// Read every *.test.ts under backend/ and every workspace package name from a checkout.
export function buildIndex(repoArg) {
  const repo = resolve(repoArg);
  const index = new Map();
  for (const full of (existsSync(join(repo, 'backend')) ? walk(join(repo, 'backend'), []) : []).sort()) {
    const rel = relative(repo, full).split(sep).join('/');
    index.set(...indexTest(rel, readFileSync(full, 'utf8')));
  }
  const packages = new Map();
  for (const group of ['backend', 'packages']) {
    if (!existsSync(join(repo, group))) continue;
    for (const entry of readdirSync(join(repo, group)).sort()) {
      const manifest = join(repo, group, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkgName = JSON.parse(readFileSync(manifest, 'utf8')).name;
      if (pkgName) packages.set(`${group}/${entry}`, pkgName);
    }
  }
  return { index, packages };
}

/** `git diff --name-status -M base head` as { changed, deleted }. A rename is a delete and an add. */
export function diffPaths(repo, base, head) {
  const out = execFileSync('git', ['-C', repo, 'diff', '--name-status', '-M', '-z', base, head], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parts = out.split('\0').filter(Boolean);
  const changed = [];
  const deleted = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i][0];
    if (status === 'R' || status === 'C') {
      if (status === 'R') deleted.push(parts[i + 1]);
      changed.push(parts[i + 2]);
      i += 2;
    } else {
      (status === 'D' ? deleted : changed).push(parts[i + 1]);
      i += 1;
    }
  }
  return { changed, deleted };
}

function main(argv) {
  const opt = { tests: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tests') opt.tests.push(argv[++i]);
    else if (['--repo', '--base', '--head', '--always'].includes(a)) opt[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opt.repo || !opt.base || !opt.head) throw new Error('usage: touched-tests.mjs --repo <dir> --base <sha> --head <sha> [--always <file>] [--tests <glob>]...');
  const always = opt.always ? parseAlwaysList(readFileSync(opt.always, 'utf8')) : { tests: [], sensitive: [] };
  const { index, packages } = buildIndex(opt.repo);
  const { changed, deleted } = diffPaths(opt.repo, opt.base, opt.head);
  const selection = selectTests({ changed, deleted, index, always, packages, extra: opt.tests });
  process.stdout.write(`${JSON.stringify({ base: opt.base, head: opt.head, changed: changed.length, deleted: deleted.length, ...selection }, null, 1)}\n`);
  if (selection.refusals.length) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`touched-tests: ${err.message}\n`);
    process.exit(1);
  }
}
