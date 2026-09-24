/**
 * P0 decision (2026-09-24, lane FIXV): demo formula seeding runs ON THE VAULT BOX — split
 * scripts/demo-seed.ts into an independent factory phase (app box, rawprod_demo) and vault
 * phase (vault box, vault_demo), with no network path between them, agreeing on the material
 * and formula ids that cross that boundary through a pure, deterministic id contract
 * (scripts/demo-seed-shared.ts) instead of a live query in either direction.
 *
 * This test proves that contract holds by calling `runDemoSeedVault` and `runDemoSeedFactory`
 * SEPARATELY (never the combined `runDemoSeed`) and checking the cross-referenced rows agree —
 * exactly the two directions that cross the box boundary in real ops:
 *   1. formula id: the factory's `packaging.product_master.formula_id` equals the vault's own
 *      `formula.formula_master.formula_id`, with NO query between the two calls.
 *   2. material id: a formula ingredient the vault phase sealed decrypts to a `materialId` that
 *      is a REAL row in the factory's `masterdata.material` — proven by actually decrypting it
 *      (not just comparing ids in the abstract).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  ensureSchema,
  TEST_DATABASE_URL,
  closeTestClient,
} from '../../../test-support/db.js';
import {
  ensureSchema as ensureFormulaSchema,
  TEST_DATABASE_URL as FORMULA_TEST_DATABASE_URL,
  closeTestClient as closeFormulaClient,
} from '../../../cluster-formula/src/__tests__/db.js';
import { runDemoSeedVault, runDemoSeedFactory } from '../../../../scripts/demo-seed.js';
import { demoFormulaId, demoFormulaVersionId, demoMaterialId, DEMO_FORMULA_DEFS } from '../../../../scripts/demo-seed-shared.js';
import { VaultService } from '../../../cluster-formula/src/vault.service.js';
import { EnvKmsAdapter } from '../../../cluster-formula/src/crypto/env-kms.adapter.js';
import { ConfigService } from '../../../backend-kernel/src/config/config.service.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as formulaSchema from '@ra/data-formula';

let sql: ReturnType<typeof postgres>;
let formulaSql: ReturnType<typeof postgres>;

before(async () => {
  await ensureSchema();
  await ensureFormulaSchema();
  // Same shared-fixture KEK convention as backend/api/src/__tests__/demo-seed.test.ts (see its
  // own comment) — every test file in a `pnpm test` run that writes to `formula.audit_events`
  // must sign under the SAME key, or a later verifyAuditChain() sees a mismatch that isn't
  // real tampering, just a different test file's key.
  process.env.FORMULA_KEK = process.env.FORMULA_KEK ?? 'E5XKPEcT95cQUOo4NpUPk1EPEDFMGzp3AAu27ComFvg=';
  sql = postgres(TEST_DATABASE_URL, { max: 2, prepare: false });
  formulaSql = FORMULA_TEST_DATABASE_URL === TEST_DATABASE_URL ? sql : postgres(FORMULA_TEST_DATABASE_URL, { max: 2, prepare: false });
});

after(async () => {
  await sql.end({ timeout: 5 });
  if (formulaSql !== sql) await formulaSql.end({ timeout: 5 });
  await closeTestClient();
  await closeFormulaClient();
});

test('deterministic id contract: vault phase and factory phase agree on ids with zero coordination between them', async () => {
  // Vault first, then factory — but see demo-seed.ts's own doc comment on runDemoSeed: order
  // must not matter for correctness, and this test's assertions don't depend on it either.
  const vaultSummary = await runDemoSeedVault({ formulaDatabaseUrl: FORMULA_TEST_DATABASE_URL, quiet: true });
  const factorySummary = await runDemoSeedFactory({ databaseUrl: TEST_DATABASE_URL, quiet: true });

  assert.equal(vaultSummary.formulas, DEMO_FORMULA_DEFS.length);
  assert.equal(vaultSummary.formulaVersionsApproved, DEMO_FORMULA_DEFS.length);
  assert.ok(factorySummary.materials > 0);
  assert.ok(factorySummary.productSkus > 0);

  const kms = new EnvKmsAdapter(new ConfigService(process.env));
  const formulaDb = drizzle(formulaSql, { schema: formulaSchema });
  const vault = new VaultService(formulaDb as any, kms);

  for (const def of DEMO_FORMULA_DEFS) {
    const formulaId = demoFormulaId(def.code);
    const versionId = demoFormulaVersionId(def.code, 1);

    // 1. formula id: the vault phase's own row exists under the deterministic id — never a
    // server-generated random uuidv7 (createFormula's ordinary default).
    const vaultRow = (await formulaSql`
      select formula_id as id, current_version_id as version from formula.formula_master where formula_code = ${def.code} limit 1
    `)[0] as { id: string; version: string | null } | undefined;
    assert.ok(vaultRow, `vault phase did not create formula ${def.code}`);
    assert.equal(vaultRow!.id, formulaId, 'vault phase formula id is not the deterministic id demo-seed-shared.ts computes');
    assert.equal(vaultRow!.version, versionId, 'vault phase version id is not the deterministic id demo-seed-shared.ts computes');

    // The factory phase referenced that SAME id when building the product catalog — it never
    // queried vault_demo to learn it (runDemoSeedFactory above ran against TEST_DATABASE_URL
    // only; it was never given formulaDatabaseUrl at all).
    const productRow = (await sql`
      select product_id as id from packaging.product_master where formula_id = ${formulaId} limit 1
    `)[0] as { id: string } | undefined;
    assert.ok(productRow, `factory phase created no product referencing formula ${def.code}'s deterministic id ${formulaId}`);

    // 2. material id: decrypt the vault phase's own sealed ingredients and confirm every
    // materialId resolves to a REAL row the factory phase created in masterdata.material —
    // proof that the two phases' independently-computed material ids actually match, not just
    // that they're both syntactically UUID-shaped.
    const ingredients = await vault.decryptVersion(versionId, {
      actorId: null,
      action: 'formula.floor.read',
      entityType: 'formula_version',
      entityId: versionId,
    });
    assert.ok(ingredients && ingredients.length > 0, `no ingredients decrypted for ${def.code}`);
    for (const ing of ingredients!) {
      // The vault phase computed this materialId with zero knowledge of what the factory phase
      // actually inserted (it never queried rawprod_demo) — this is the real proof the contract
      // holds: the id it guessed IS a real row the factory independently created under the same
      // deterministic function.
      const materialRow = (await sql`select material_id as id, material_code as code from masterdata.material where material_id = ${ing.materialId} limit 1`)[0] as { id: string; code: string } | undefined;
      assert.ok(materialRow, `factory phase has no masterdata.material row for ${def.code}'s sealed ingredient materialId ${ing.materialId}`);
      assert.equal(ing.materialId, demoMaterialId(materialRow!.code), 'materialId does not equal demoMaterialId(its own material_code) — the deterministic id contract is broken');
    }
  }
});
