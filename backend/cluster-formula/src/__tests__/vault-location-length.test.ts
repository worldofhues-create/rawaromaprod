/**
 * Regression (rc-rawprod-2026-09-24.4): formula_vault.vault_location was varchar(255), but
 * FormulasService stores JSON.stringify(<wrapped DEK>) there. A real AWS KMS envelope
 * (GenerateDataKey CiphertextBlob ≈ 184 bytes → ~248 base64 chars, plus the JSON wrapper)
 * exceeds 255, so every seal failed with "value too long for type character varying(255)".
 * This seals a formula through the real services with an AWS-shaped envelope > 255 chars and
 * proves it both persists and unwraps (ingredient seal round-trips).
 */
import { test, before, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { EnvKmsAdapter } from '../crypto/env-kms.adapter.js';
import type { KmsPort, VaultKeyContext, WrappedKey } from '../crypto/kms.port.js';
import { VaultService } from '../vault.service.js';
import { FormulasService } from '../formulas/formulas.service.js';
import { formulaVault } from '@ra/data-formula';
import { uuidv7 } from '@core/data-kernel';
import { principal } from '../../../test-support/db.js';
import { ensureSchema, formulaDb, closeTestClient } from './db.js';

const config = new ConfigService({
  DATABASE_URL: 'postgres://apple@localhost:5432/rawprod_u4_vault_test',
  JWT_SECRET: 'x'.repeat(32),
  FORMULA_KEK: 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=',
});

/** AWS-KMS-shaped fake: opaque ciphertext blob (iv/tag ""), realistic envelope length. */
class LongEnvelopeKms implements KmsPort {
  readonly keyRef = 'aws-kms:arn:aws:kms:ap-south-1:000000000000:key/00000000-0000-0000-0000-000000000000';
  private readonly deks = new Map<string, Buffer>();
  private readonly mac = new EnvKmsAdapter(config);
  private wrap(dek: Buffer): WrappedKey {
    const ciphertext = randomBytes(184).toString('base64');
    this.deks.set(ciphertext, dek);
    return { ciphertext, iv: '', tag: '' };
  }
  async generateDek(_c: VaultKeyContext) {
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: this.wrap(plaintext) };
  }
  async wrapExistingDek(dek: Buffer, _c: VaultKeyContext) { return this.wrap(dek); }
  async unwrapDek(w: WrappedKey, _c: VaultKeyContext) {
    const dek = this.deks.get(w.ciphertext);
    if (!dek) throw new Error('unknown ciphertext');
    return dek;
  }
  macAudit(data: string) { return this.mac.macAudit(data); }
}

const stubMasterdata = {
  findMaterial: async () => null,
  findAliasForMaterial: async () => null,
  findAliasesForMaterials: async () => new Map(),
  searchMaterials: async () => [],
};

let db: ReturnType<typeof formulaDb>;
let formulas: FormulasService;

before(async () => {
  await ensureSchema();
  db = formulaDb();
  const kms = new LongEnvelopeKms();
  const vault = new VaultService(db as any, kms);
  formulas = new FormulasService(db as any, kms, vault, stubMasterdata as any);
});

afterAll(async () => {
  await closeTestClient();
});

test('vault_location: sealing a formula with a KMS envelope longer than 255 chars succeeds', async () => {
  const p = principal({ userId: uuidv7() });
  const formula = await formulas.createFormula({ formulaCode: `VL-${uuidv7()}`, formulaName: 'Long envelope' }, p);
  const [row] = await (db as any).select().from(formulaVault).where(eq(formulaVault.formulaId, formula.formulaId));
  assert.ok(row.vaultLocation.length > 255, `envelope length ${row.vaultLocation.length} should exceed 255`);

  const version = await formulas.createVersion({ formulaId: formula.formulaId, versionNumber: 1 }, p);
  await formulas.addIngredients(version.formulaVersionId, { ingredients: [{ materialId: uuidv7(), percentage: 10 }] }, p);
});
