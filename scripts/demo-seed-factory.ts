/**
 * CLI entry — `pnpm demo:seed:factory` / `tsx scripts/demo-seed-factory.ts`.
 *
 * Runs ONLY the FACTORY phase of the ALEMBIC OS Demo Factory seed (scripts/demo-seed.ts) —
 * everything that lives in `rawprod_demo` (app box). Never opens a connection to `vault_demo` /
 * vault-pg (P0 decision, lane FIXV: no new network path from the app box to vault-pg). Run this
 * on the APP box; run `demo-seed-vault.ts` on the VAULT box (either order — see
 * `runDemoSeed`'s own doc comment on the deterministic id contract that makes order not
 * matter). `infra/aws/demo/reset-demo.sh` is what actually invokes this in ops.
 *
 * Env: DATABASE_URL (rawprod_demo). See demo-seed.README.md for the rest.
 */
import { fileURLToPath } from 'node:url';
import { runDemoSeedFactory } from './demo-seed.js';

const isMainModule = (() => {
  try { return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();

if (isMainModule) {
  runDemoSeedFactory()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
