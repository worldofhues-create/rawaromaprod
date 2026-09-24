/**
 * P0 decision (2026-09-24, lane FIXV): "seeding must encrypt with AwsKmsAdapter whenever
 * FORMULA_KMS_KEY_ID is set (demo: alias/rawprod-demo-vault-envelope via role
 * rawprod-vault-demo); the local/env adapter only in tests. Test: seeded formula decrypts
 * through vault-main in prod mode (mock KMS client in unit tests)."
 *
 * Two things proven here, against real Postgres (lane FIXV's own throwaway `formula` schema,
 * `db.ts` in this directory — same harness `vault-sod.test.ts`/`aws-kms-adapter.test.ts` use):
 *
 *   1. `scripts/demo-seed.ts`'s `resolveSeedKmsAdapter(config)` picks `AwsKmsAdapter` iff
 *      `FORMULA_KMS_KEY_ID` is configured, `EnvKmsAdapter` otherwise (no process.env mutation —
 *      `ConfigService` accepts a plain object, so this needs no env leakage across test files).
 *   2. A formula sealed through `FormulasService`+`AwsKmsAdapter` (mocked `KMSClient`) decrypts
 *      correctly through a SECOND, FRESH `VaultService`+`AwsKmsAdapter` instance pointed at the
 *      same mock client — standing in for "vault-main (VaultAppModule, APP_ENV=prod) reads what
 *      the seed wrote", without a real AWS account. Uses its OWN uniquely-coded formula
 *      (`FIXV-KMS-TEST-*`), never the shared `DEMO-FRM-001`/`DEMO-FRM-002` fixtures
 *      `demo-seed-split.test.ts` and `backend/api/src/__tests__/demo-seed.test.ts` seed — so
 *      this file's mocked KMS material can never collide with formulas the real seed creates.
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { KMSClient } from '@aws-sdk/client-kms';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import { AwsKmsAdapter } from '../crypto/aws-kms.adapter.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';
import { resolveSeedKmsAdapter } from '../../../../scripts/demo-seed.js';

// Same shared fixture KEK every EnvKmsAdapter-backed formula test file uses (vault-sod.test.ts,
// vault-lifecycle.test.ts, manufacturing-instruction.test.ts, vault-rewrap.test.ts,
// backend/api/src/__tests__/demo-seed.test.ts).
const TEST_KEK = 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';

/** Same FakeKmsClient as vault-rewrap.test.ts (kept local/duplicated per that file's own note —
 * a shared test-support module is a reasonable fast-follow, not worth a cross-file coupling
 * here), including its ONE deliberate deviation from aws-kms-adapter.test.ts's version: the
 * audit-HMAC GenerateDataKey call (EncryptionContext.purpose === 'vault-audit-hmac') returns
 * the SAME bytes as TEST_KEK instead of fresh random ones. `formula.audit_events`/chain_seq is
 * ONE global sequence shared by every test file against this lane's single throwaway DB
 * (db.ts) — without this, this file's AwsKmsAdapter instances would each mint their OWN random
 * audit key, and every OTHER test file's full-chain `verifyAuditChain()` check (which
 * recomputes every row's hash under ITS OWN EnvKmsAdapter/TEST_KEK) would report this file's
 * rows as tampered. Not a product bug — a shared-fixture interaction this file controls for,
 * exactly like vault-rewrap.test.ts already does for the same reason. */
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

before(async () => {
  await ensureSchema();
});

afterAll(async () => {
  await closeTestClient();
});

test('resolveSeedKmsAdapter: picks AwsKmsAdapter iff FORMULA_KMS_KEY_ID is set, EnvKmsAdapter otherwise', () => {
  const withKey = new ConfigService({
    JWT_SECRET: 'x'.repeat(32),
    FORMULA_KMS_KEY_ID: 'alias/rawprod-demo-vault-envelope',
  });
  const withoutKey = new ConfigService({
    JWT_SECRET: 'x'.repeat(32),
    FORMULA_KEK: TEST_KEK,
  });

  const adapterWithKey = resolveSeedKmsAdapter(withKey, new FakeKmsClient() as unknown as KMSClient);
  assert.ok(adapterWithKey instanceof AwsKmsAdapter, 'FORMULA_KMS_KEY_ID set must select AwsKmsAdapter');

  const adapterWithoutKey = resolveSeedKmsAdapter(withoutKey);
  assert.ok(adapterWithoutKey instanceof EnvKmsAdapter, 'FORMULA_KMS_KEY_ID unset must select EnvKmsAdapter (test-only fallback)');
});

test('a formula sealed via AwsKmsAdapter (mocked KMS) decrypts through a FRESH AwsKmsAdapter instance (mock prod-mode vault-main)', async () => {
  const config = new ConfigService({
    JWT_SECRET: 'x'.repeat(32),
    FORMULA_KMS_KEY_ID: 'alias/fixv-kms-test-envelope',
  });
  const fakeClient = new FakeKmsClient() as unknown as KMSClient;

  // ── "seed time": seal with a KmsPort resolved exactly the way scripts/demo-seed-vault.ts
  // resolves it (resolveSeedKmsAdapter) — never EnvKmsAdapter, since FORMULA_KMS_KEY_ID is set.
  const sealingKms = resolveSeedKmsAdapter(config, fakeClient);
  assert.ok(sealingKms instanceof AwsKmsAdapter);

  const db = formulaDb();
  const sealingVault = new VaultService(db as any, sealingKms);
  const formulas = new FormulasService(db as any, sealingKms, sealingVault, stubMasterdata);
  const approvals = new ApprovalsService(db as any, sealingVault);

  const formulator = principal({ userId: randomUUID() });
  const approver = principal({ userId: randomUUID() }); // genuinely different user — §108 SoD

  const materialId = randomUUID();
  const formula = await formulas.createFormula(
    { formulaCode: `FIXV-KMS-TEST-${randomUUID()}`, formulaName: 'FIXV KMS round-trip test formula' },
    formulator,
  );
  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, formulator);
  await formulas.addIngredients(
    version.formulaVersionId,
    { ingredients: [{ materialId, percentage: 42.5, sequenceNo: 1 }] },
    formulator,
  );
  await formulas.finalizeVersion(version.formulaVersionId, formulator);
  await approvals.submitForReview(version.formulaVersionId, {}, formulator);
  await approvals.approveVersion(version.formulaVersionId, { remarks: 'FIXV KMS test' }, approver);

  // ── "vault-main in prod mode, later / a different process": a completely FRESH
  // VaultService + AwsKmsAdapter instance, sharing only the mock KMS client (standing in for
  // the same real AWS KMS key) — never the sealing instance's in-memory state.
  const readingKms = new AwsKmsAdapter(config, fakeClient);
  const readingVault = new VaultService(db as any, readingKms);

  const decrypted = await readingVault.decryptVersion(version.formulaVersionId, {
    actorId: approver.userId,
    action: 'formula.floor.read',
    entityType: 'formula_version',
    entityId: version.formulaVersionId,
  });

  assert.ok(decrypted, 'decryptVersion returned null — version not approved/locked?');
  assert.equal(decrypted!.length, 1);
  assert.equal(decrypted![0]!.materialId, materialId);
  assert.equal(decrypted![0]!.percentage, 42.5);
});
