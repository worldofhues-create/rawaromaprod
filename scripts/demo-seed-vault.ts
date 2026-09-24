/**
 * CLI entry — `pnpm demo:seed:vault` / `tsx scripts/demo-seed-vault.ts`.
 *
 * Runs ONLY the VAULT phase of the ALEMBIC OS Demo Factory seed (scripts/demo-seed.ts) — seals
 * the 2 demo formulas straight into `vault_demo` (vault box), through the real vault-main
 * services, encrypted with `AwsKmsAdapter` whenever `FORMULA_KMS_KEY_ID` is set (P0 decision,
 * lane FIXV — see `resolveSeedKmsAdapter`'s own doc comment). Never opens a connection to the
 * main (`rawprod_demo`) database. Run this on the VAULT box; run `demo-seed-factory.ts` on the
 * APP box. `infra/aws/demo/reset-demo.sh` is what actually invokes this in ops.
 *
 * Env: FORMULA_DATABASE_URL (vault_demo), FORMULA_KMS_KEY_ID (+ FORMULA_KMS_REGION) for the
 * real AWS KMS envelope key. See demo-seed.README.md for the rest.
 */
import { fileURLToPath } from 'node:url';
import { runDemoSeedVault } from './demo-seed.js';

const isMainModule = (() => {
  try { return !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();

if (isMainModule) {
  runDemoSeedVault()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
