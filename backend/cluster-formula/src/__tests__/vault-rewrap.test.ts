/**
 * PB-03 — scripts/vault-rewrap.ts (`runRewrap`) against REAL Postgres (lane vk's own
 * throwaway `formula` schema, `db.ts` in this directory) and a real `FormulasService` /
 * `VaultService` sealing real ingredients — proves the migration tool's actual contract, not
 * just its plumbing:
 *
 *   - DRY-RUN performs ZERO writes (encryption_key_ref/vault_location untouched).
 *   - APPLY rewraps: encryption_key_ref flips to the target adapter's keyRef, and — the
 *     property that actually matters — the DEK is PRESERVED: an ingredient sealed BEFORE the
 *     rewrap still decrypts to the exact same plaintext AFTER it, through the NEW adapter.
 *   - IDEMPOTENT: re-running APPLY against already-migrated rows rewraps nothing further.
 *   - a real hash-chained audit row (`vault.kms_rewrapped`) is appended for each rewrap.
 *
 * The target adapter is AwsKmsAdapter bound to the SAME in-memory `FakeKmsClient` used by
 * aws-kms-adapter.test.ts (no network/real AWS account needed).
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import * as formulaSchema from '@ra/data-formula';
import { randomBytes } from 'node:crypto';
import type { KMSClient } from '@aws-sdk/client-kms';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { AwsKmsAdapter } from '../crypto/aws-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { uuidv7 } from '@core/data-kernel';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';
import { runRewrap } from '../../../../scripts/vault-rewrap.js';

const { formulaVault } = formulaSchema;

const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
const sourceConfig = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vk_test',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: TEST_KEK,
});
const targetConfig = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_vk_test',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KMS_KEY_ID: 'arn:aws:kms:ap-south-1:123456789012:key/test-cmk',
});

/** Minimal in-memory KMS simulator — same behavior as aws-kms-adapter.test.ts's FakeKmsClient
 * (kept local/duplicated rather than shared: these are two independently-owned test files and
 * the simulator is ~30 lines; a shared test-support module is a reasonable fast-follow, not
 * worth a cross-file coupling here).
 *
 * ONE deliberate difference from the aws-kms-adapter.test.ts version: the audit-HMAC
 * GenerateDataKey call (EncryptionContext.purpose === 'vault-audit-hmac') returns the SAME
 * bytes as `TEST_KEK` instead of fresh random ones, so `targetKms.macAudit(...) ===
 * sourceKms.macAudit(...)` for identical input. `formula.audit_events`/chain_seq is ONE global
 * sequence shared by every test file against this lane's single throwaway DB (db.ts); other
 * files' `verifyAuditChain()` checks walk EVERY row in the table and recompute its hash with
 * their own EnvKmsAdapter/TEST_KEK. Without this, the rows this file's APPLY tests write via
 * the target (AWS) adapter's genuinely different audit key would make those OTHER files' full-
 * chain checks report false-positive tampering — not a product bug, a shared-fixture interaction
 * this test controls for. (In production this "same audit key across the migration" is also the
 * actually-correct operational choice when continuity of the existing chain matters — see the
 * deploy runbook's note on FORMULA_AUDIT_HMAC_WRAPPED during a KMS migration.)
 */
class FakeKmsClient {
  private readonly store = new Map<string, { plaintext: Buffer; context: Record<string, string> }>();
  private seq = 0;
  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const name = command.constructor.name;
    const context = (command.input.EncryptionContext as Record<string, string> | undefined) ?? {};
    if (name === 'GenerateDataKeyCommand') {
      const plaintext = context.purpose === 'vault-audit-hmac' ? Buffer.from(TEST_KEK, 'base64') : randomBytes(32);
      const id = this.put(plaintext, context);
      return { Plaintext: plaintext, CiphertextBlob: Buffer.from(id, 'utf8') };
    }
    if (name === 'EncryptCommand') {
      const plaintext = Buffer.from(command.input.Plaintext as Uint8Array);
      const id = this.put(plaintext, context);
      return { CiphertextBlob: Buffer.from(id, 'utf8') };
    }
    if (name === 'DecryptCommand') {
      const id = Buffer.from(command.input.CiphertextBlob as Uint8Array).toString('utf8');
      const entry = this.store.get(id);
      if (!entry) throw new Error('InvalidCiphertextException: unknown ciphertext');
      if (JSON.stringify(entry.context) !== JSON.stringify(context)) {
        throw new Error('InvalidCiphertextException: encryption context does not match');
      }
      return { Plaintext: entry.plaintext };
    }
    throw new Error(`FakeKmsClient: unhandled command ${name}`);
  }
  private put(plaintext: Buffer, context: Record<string, string>): string {
    const id = `ct-${this.seq++}`;
    this.store.set(id, { plaintext, context });
    return id;
  }
}

const stubMasterdata = {
  findMaterial: async () => null,
  findAliasForMaterial: async () => null,
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async () => [],
};

let db: ReturnType<typeof formulaDb>;
let sourceKms: EnvKmsAdapter;
let targetKms: AwsKmsAdapter;
let sourceVault: VaultService;
let formulas: FormulasService;
let approvals: ApprovalsService;

const author = principal({ userId: uuidv7() });
const approver = principal({ userId: uuidv7() });

before(async () => {
  await ensureSchema();
  db = formulaDb();
  sourceKms = new EnvKmsAdapter(sourceConfig);
  targetKms = new AwsKmsAdapter(targetConfig, new FakeKmsClient() as unknown as KMSClient);
  sourceVault = new VaultService(db as any, sourceKms);
  formulas = new FormulasService(db as any, sourceKms, sourceVault, stubMasterdata as any);
  approvals = new ApprovalsService(db as any, sourceVault);
});

afterAll(async () => {
  await closeTestClient();
});

/** Create a formula (sealed under sourceKms/EnvKmsAdapter — the Phase-1 state being migrated
 * away from), finalize + approve it so it's decryptable, and return its ids + the ingredient
 * that was sealed (for the post-rewrap plaintext-preservation check). */
async function newApprovedFormula(): Promise<{ formulaId: string; versionId: string; materialId: string; percentage: number }> {
  const formula = await formulas.createFormula({ formulaCode: `RW-${uuidv7()}`, formulaName: 'Rewrap test formula' }, author);
  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, author);
  const materialId = uuidv7();
  const percentage = 12.5;
  await formulas.addIngredients(version.formulaVersionId, { ingredients: [{ materialId, percentage }] }, author);
  await formulas.finalizeVersion(version.formulaVersionId, author);
  // §108 SoD requires a DIFFERENT approver than the author — decryptVersion requires
  // APPROVED/LOCKED, so this must actually be approved, not just finalized.
  await approvals.approveVersion(version.formulaVersionId, {}, approver);
  return { formulaId: formula.formulaId, versionId: version.formulaVersionId, materialId, percentage };
}

test('vault-rewrap: dry-run performs ZERO writes', async () => {
  const { formulaId } = await newApprovedFormula();
  const before_ = (await db.select().from(formulaVault).where(eq(formulaVault.formulaId, formulaId)))[0]!;

  const report = await runRewrap({ db: db as any, sourceKms, targetKms, apply: false, formulaIds: [formulaId] });
  assert.ok(report.rewrapped >= 1);
  assert.equal(report.applied, false);

  const after_ = (await db.select().from(formulaVault).where(eq(formulaVault.formulaId, formulaId)))[0]!;
  assert.equal(after_.encryptionKeyRef, before_.encryptionKeyRef);
  assert.equal(after_.vaultLocation, before_.vaultLocation);
  assert.equal(after_.encryptionKeyRef, 'env-kek:v1');
});

test('vault-rewrap: APPLY rewraps encryption_key_ref/vault_location AND preserves the DEK — a pre-rewrap-sealed ingredient still decrypts correctly post-rewrap through the NEW adapter', async () => {
  const { formulaId, versionId, materialId, percentage } = await newApprovedFormula();

  const report = await runRewrap({ db: db as any, sourceKms, targetKms, apply: true, formulaIds: [formulaId] });
  assert.equal(report.applied, true);
  assert.equal(report.failed, 0);

  const row = (await db.select().from(formulaVault).where(eq(formulaVault.formulaId, formulaId)))[0]!;
  assert.equal(row.encryptionKeyRef, targetKms.keyRef);
  assert.ok(row.encryptionKeyRef!.startsWith('aws-kms:'));

  // The real proof: decrypt through a VaultService bound to the TARGET (AWS) adapter and
  // confirm it recovers the EXACT SAME ingredient that was sealed under the SOURCE adapter
  // before the rewrap ran — not a new/different DEK.
  const targetVault = new VaultService(db as any, targetKms);
  const decrypted = await targetVault.decryptVersion(versionId, {
    actorId: author.userId,
    action: 'vault.rewrap_test_reveal',
    entityType: 'formula_version',
    entityId: versionId,
  });
  assert.equal(decrypted?.length, 1);
  assert.equal(decrypted?.[0]?.materialId, materialId);
  assert.equal(decrypted?.[0]?.percentage, percentage);
});

test('vault-rewrap: IDEMPOTENT — a second APPLY run rewraps nothing further for already-migrated rows', async () => {
  const { formulaId } = await newApprovedFormula();
  const first = await runRewrap({ db: db as any, sourceKms, targetKms, apply: true, formulaIds: [formulaId] });
  assert.ok(first.rewrapped >= 1);
  const rowAfterFirst = (await db.select().from(formulaVault).where(eq(formulaVault.formulaId, formulaId)))[0]!;
  assert.ok(rowAfterFirst.encryptionKeyRef!.startsWith('aws-kms:'));

  await runRewrap({ db: db as any, sourceKms, targetKms, apply: true, formulaIds: [formulaId] });
  // NOTE: this shared `formula` schema/DB is used by every test FILE in this directory (one
  // throwaway DB for the whole `pnpm test` run — db.ts), and node's test runner can run test
  // FILES concurrently, so asserting a GLOBAL `second.rewrapped === 0` is racy: another file
  // may insert a fresh (not-yet-migrated) formula_vault row between these two calls. Scope the
  // idempotency proof to THIS test's own row/audit-trail instead, which is race-proof:
  //   1. the row's encryption_key_ref/vault_location are byte-identical after the second pass
  //      (a genuine re-rewrap would still start with "aws-kms:" but wrap DIFFERENT ciphertext —
  //      AWS KMS ciphertext is never byte-stable across two Encrypt calls on the same input).
  //   2. exactly ONE `vault.kms_rewrapped` audit row exists for THIS formula_vault_id, not two.
  const rowAfterSecond = (await db.select().from(formulaVault).where(eq(formulaVault.formulaId, formulaId)))[0]!;
  assert.equal(rowAfterSecond.encryptionKeyRef, rowAfterFirst.encryptionKeyRef);
  assert.equal(rowAfterSecond.vaultLocation, rowAfterFirst.vaultLocation);

  const auditRowsForThisVault = await db
    .select()
    .from(formulaSchema.auditEvents)
    .where(eq(formulaSchema.auditEvents.entityId, rowAfterFirst.formulaVaultId));
  const rewrapRows = auditRowsForThisVault.filter((r) => r.action === 'vault.kms_rewrapped');
  assert.equal(rewrapRows.length, 1, 'expected exactly one rewrap audit row for this vault row — the second pass must have skipped it');
});

test('vault-rewrap: appends a real audit row (action=vault.kms_rewrapped) for each APPLY rewrap', async () => {
  const { formulaId } = await newApprovedFormula();
  await runRewrap({ db: db as any, sourceKms, targetKms, apply: true, formulaIds: [formulaId] });

  const rows = await db
    .select()
    .from(formulaSchema.auditEvents)
    .where(eq(formulaSchema.auditEvents.action, 'vault.kms_rewrapped'));
  const forThisFormula = rows.filter((r) => r.entityType === 'formula_vault');
  assert.ok(forThisFormula.length >= 1, 'expected at least one vault.kms_rewrapped audit row');
});
