#!/usr/bin/env node
/**
 * RP-FAC test runner — `pnpm test` at the repo root. RawProd has zero test-runner config (no
 * vitest/jest anywhere in the repo), so per the lane brief this uses Node's built-in `node:test`
 * (node >=22, already the engines floor) instead of adding a new dependency. TypeScript is
 * loaded via `@swc-node/register` (already a devDependency, used by every cluster's `dev`
 * script) rather than pre-compiling.
 *
 * Recursively collects backend/**​/*.test.ts (skipping node_modules/dist) and runs them under
 * `node --test`. Usage: `node backend/test-support/run-tests.mjs [--test-name-pattern=foo]`.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const searchRoot = join(repoRoot, 'backend');

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = collect(searchRoot).sort();
if (files.length === 0) {
  console.error('No *.test.ts files found under backend/.');
  process.exit(1);
}
console.log(`Running ${files.length} test file(s):`);
for (const f of files) console.log('  ' + relative(repoRoot, f));

const child = spawn(
  process.execPath,
  [
    '--import',
    '@swc-node/register/esm-register',
    '--test',
    // Files share ONE Postgres and some singleton rows (bridge.connector_config 'default',
    // formula_vault for rewrap): parallel files raced on them twice. Serialize.
    '--test-concurrency=1',
    ...process.argv.slice(2),
    ...files,
  ],
  { stdio: 'inherit', cwd: repoRoot, env: process.env },
);
child.on('exit', (code) => process.exit(code ?? 1));
