/**
 * vault-rewrap — PB-03 migration tool (V4 §109.2). Re-encrypts every FORMULA_VAULT row's DEK
 * from its CURRENT key source (the env/file KEK adapters — Phase-1, dev/test as of PB-03) to
 * AWS KMS (AwsKmsAdapter), WITHOUT touching any sealed ingredient ciphertext: the DEK's
 * plaintext bytes are preserved bit-for-bit — unwrap under the OLD adapter, wrap the SAME
 * bytes under the NEW one via `KmsPort.wrapExistingDek` (never `generateDek`, which would mint
 * a DIFFERENT key and silently orphan every already-sealed ingredient row under the old DEK).
 *
 * DRY-RUN BY DEFAULT — reports counts only, writes nothing. Pass --apply to actually rewrap.
 *
 * IDEMPOTENT — a row whose FORMULA_VAULT.encryption_key_ref already starts with `aws-kms:` is
 * skipped (already migrated); safe to re-run after a partial failure (each row is rewrapped in
 * its own transaction, so a failure partway through leaves already-rewrapped rows untouched on
 * the next run and only re-attempts the rest).
 *
 * Every successful rewrap appends a real, hash-chained VaultService audit row (action
 * `vault.kms_rewrapped`) in the SAME transaction as the row update, using the REAL
 * VaultService/AwsKmsAdapter classes — not a hand-rolled duplicate of the chain logic — so
 * `verifyAuditChain()` covers the migration itself.
 *
 * To be run by P0 during the AWS KMS migration (V4 §109 / PB-03), against the vault's OWN
 * connection (FORMULA_DATABASE_URL — the ra_vault role, once scripts/provision-vault-isolation.sql
 * has been applied):
 *
 *   FORMULA_DATABASE_URL=postgres://ra_vault:...@host/db \
 *   FORMULA_KEK=<current base64 KEK> \
 *   FORMULA_KMS_KEY_ID=<target CMK id/ARN> [FORMULA_KMS_REGION=...] \
 *     tsx scripts/vault-rewrap.ts                 # dry run (default) — no writes
 *
 *   ...same env...  tsx scripts/vault-rewrap.ts --apply   # actually rewrap
 *
 * Source key: set FORMULA_KEK (EnvKmsAdapter) XOR FORMULA_KEK_FILE (FileKmsAdapter) —
 * whichever is currently wrapping the rows being migrated. Target: FORMULA_KMS_KEY_ID (+
 * optional FORMULA_KMS_REGION / FORMULA_KMS_TENANT_ID / FORMULA_KMS_TIMEOUT_MS).
 *
 * This reaches into `backend/cluster-formula/src/**` by relative path rather than the
 * package's public barrel (`@ra/cluster-formula` exports ONLY `FormulaModule`/`FORMULA_DB`/
 * `FORMULA_LOOKUP` — deliberately, so nothing outside the cluster can read/decrypt a recipe).
 * Same precedent as `scripts/provision-vault-isolation.sql` and
 * `scripts/create-vault-audit-guard.cjs`: a break-glass ops/migration tool run out-of-band by
 * P0, not application code, and not a widening of the normal request-path boundary.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as formulaSchema from '@ra/data-formula';
import { ConfigService } from '../backend/backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../backend/cluster-formula/src/crypto/env-kms.adapter.js';
import { FileKmsAdapter } from '../backend/cluster-formula/src/crypto/file-kms.adapter.js';
import { AwsKmsAdapter } from '../backend/cluster-formula/src/crypto/aws-kms.adapter.js';
import { VaultService } from '../backend/cluster-formula/src/vault.service.js';
import type { KmsPort, VaultKeyContext, WrappedKey } from '../backend/cluster-formula/src/crypto/kms.port.js';

const { formulaVault } = formulaSchema;

export const APPLY_FLAG = '--apply';

/** Parse a FORMULA_VAULT.vault_location blob defensively — same tolerance as vault.service.ts's
 * parseWrappedKey, without duplicating its NestJS-exception-typed strict validation (this is a
 * standalone script, not a request handler). */
export function parseWrapped(raw: string): WrappedKey {
  const w = JSON.parse(raw) as Partial<WrappedKey>;
  if (typeof w?.ciphertext !== 'string') throw new Error('malformed vault_location JSON (no ciphertext)');
  return { ciphertext: w.ciphertext, iv: w.iv ?? '', tag: w.tag ?? '' };
}

export interface RewrapReport {
  totalRows: number;
  alreadyMigrated: number;
  rewrapped: number;
  failed: number;
  failures: { formulaVaultId: string; formulaId: string | null; reason: string }[];
  applied: boolean;
}

/** Core rewrap loop, factored out so tests can call it directly against a test DB + injected
 * source/target adapters without spawning the CLI process. */
export async function runRewrap(opts: {
  db: ReturnType<typeof drizzle<typeof formulaSchema>>;
  sourceKms: KmsPort;
  targetKms: KmsPort;
  apply: boolean;
}): Promise<RewrapReport> {
  const { db, sourceKms, targetKms, apply } = opts;
  const vault = new VaultService(db as never, targetKms);
  const rows = await db.select().from(formulaVault);

  const report: RewrapReport = {
    totalRows: rows.length,
    alreadyMigrated: 0,
    rewrapped: 0,
    failed: 0,
    failures: [],
    applied: apply,
  };

  for (const row of rows) {
    if (!row.formulaId || !row.vaultLocation) {
      report.failed++;
      report.failures.push({ formulaVaultId: row.formulaVaultId, formulaId: row.formulaId, reason: 'missing formulaId/vaultLocation' });
      continue;
    }
    if (row.encryptionKeyRef?.startsWith('aws-kms:')) {
      report.alreadyMigrated++;
      continue;
    }
    const context: VaultKeyContext = { formulaId: row.formulaId, vaultId: row.formulaVaultId };
    try {
      const wrapped = parseWrapped(row.vaultLocation);
      const dek = await sourceKms.unwrapDek(wrapped, context);
      const rewrapped = await targetKms.wrapExistingDek(dek, context);

      if (apply) {
        await db.transaction(async (tx) => {
          await tx
            .update(formulaVault)
            .set({ encryptionKeyRef: targetKms.keyRef, vaultLocation: JSON.stringify(rewrapped) })
            .where(eq(formulaVault.formulaVaultId, row.formulaVaultId));
          await vault.writeAudit(tx as never, {
            actorId: null,
            action: 'vault.kms_rewrapped',
            entityType: 'formula_vault',
            entityId: row.formulaVaultId,
            reason: 'PB-03 migration: rewrapped DEK from prior key source to AWS KMS',
          });
        });
      }
      report.rewrapped++;
    } catch (err) {
      report.failed++;
      report.failures.push({
        formulaVaultId: row.formulaVaultId,
        formulaId: row.formulaId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

export function printReport(report: RewrapReport): void {
  console.log('--- vault-rewrap report ---');
  console.log(`  mode:              ${report.applied ? 'APPLY (writes performed)' : 'DRY-RUN (no writes)'}`);
  console.log(`  total rows:        ${report.totalRows}`);
  console.log(`  already migrated:  ${report.alreadyMigrated}`);
  console.log(`  ${report.applied ? 'rewrapped' : 'would rewrap'}:${' '.repeat(report.applied ? 6 : 2)}${report.rewrapped}`);
  console.log(`  failed:            ${report.failed}`);
  if (report.failures.length) {
    console.log('  failures:');
    for (const f of report.failures) {
      console.log(`    - formula_vault_id=${f.formulaVaultId} formula_id=${f.formulaId ?? '(null)'}: ${f.reason}`);
    }
  }
  if (!report.applied && report.rewrapped > 0) {
    console.log(`\nDry run only — re-run with ${APPLY_FLAG} to actually rewrap ${report.rewrapped} row(s).`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes(APPLY_FLAG);
  const dbUrl = process.env.FORMULA_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('FORMULA_DATABASE_URL (or DATABASE_URL for a dev/test run) is required.');
  }

  const config = new ConfigService({
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? dbUrl,
    JWT_SECRET: process.env.JWT_SECRET ?? 'x'.repeat(32),
  } as NodeJS.ProcessEnv);

  if (config.get('FORMULA_KEK') && config.get('FORMULA_KEK_FILE')) {
    throw new Error('Set only one of FORMULA_KEK / FORMULA_KEK_FILE — the current source key, not both.');
  }
  const sourceKms: KmsPort = config.get('FORMULA_KEK_FILE') ? new FileKmsAdapter(config) : new EnvKmsAdapter(config);
  const targetKms: KmsPort = new AwsKmsAdapter(config);

  const sql = postgres(dbUrl, { max: 3 });
  const db = drizzle(sql, { schema: formulaSchema });

  console.log(`vault-rewrap: connecting… mode=${apply ? 'APPLY' : 'DRY-RUN'} target=${targetKms.keyRef}`);
  try {
    const report = await runRewrap({ db, sourceKms, targetKms, apply });
    printReport(report);
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only auto-run when invoked directly (tsx scripts/vault-rewrap.ts), not when imported by tests.
if (process.argv[1] && /vault-rewrap\.(ts|m?js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error('vault-rewrap: fatal error', err);
    process.exit(1);
  });
}
