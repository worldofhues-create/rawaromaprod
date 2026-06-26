/**
 * Offline proof that the programmatic drizzle-kit API can snapshot every schema group WITHOUT
 * the CLI `.js`-resolution bug and WITHOUT a database. Run:
 *   node --import @swc-node/register/esm-register scripts/db-validate.ts
 * Prints a table count per pg schema; non-zero exit if any group fails to load/snapshot.
 */
import { createRequire } from 'node:module';
import { SCHEMA_GROUPS, loadGroup } from './db-schema-groups.js';

// drizzle-kit's ESM bundle (api.mjs) ships a broken `__require` shim that throws on node
// builtins; the CJS build (api.js, selected by the `require` condition) works. Load it via
// createRequire so we get the functioning CJS entry regardless of the ESM loader in use.
const require = createRequire(import.meta.url);
const { generateDrizzleJson } = require('drizzle-kit/api') as typeof import('drizzle-kit/api');

async function main(): Promise<void> {
  let ok = 0;
  let fail = 0;
  let total = 0;
  for (const g of SCHEMA_GROUPS) {
    try {
      const imports = await loadGroup(g.packages);
      const json = generateDrizzleJson(imports, undefined, [g.schema], 'snake_case');
      const count = Object.keys((json as { tables?: Record<string, unknown> }).tables ?? {}).length;
      total += count;
      // eslint-disable-next-line no-console
      console.log(`OK   ${g.schema.padEnd(11)} tables=${String(count).padStart(3)}  ${g.vault ? '[vault] ' : ''}(${g.packages.join(' + ')})`);
      ok++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`FAIL ${g.schema.padEnd(11)} ${(e as Error).message}`);
      fail++;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n${ok} schema groups OK, ${fail} failed, ${total} tables total`);
  if (fail > 0) process.exit(1);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
