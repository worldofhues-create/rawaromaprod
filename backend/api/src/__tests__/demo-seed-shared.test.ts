/**
 * scripts/demo-seed-shared.ts — pure-function tests, no database. This is the deterministic id
 * contract the demo formula seed's factory phase (app box) and vault phase (vault box) rely on
 * to agree on ids with zero network call between them (P0 decision, 2026-09-24, lane FIXV). The
 * end-to-end proof against real Postgres lives in demo-seed-split.test.ts; this file locks down
 * the pure math underneath it in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  demoDeterministicId,
  demoMaterialId,
  demoFormulaId,
  demoFormulaVersionId,
  demoMaterialCodeAt,
  MATERIAL_COUNT,
  DEMO_FORMULA_DEFS,
  demoFormulaIngredientPlan,
} from '../../../../scripts/demo-seed-shared.js';

test('demoDeterministicId: same label always yields the same id, different labels never collide (for these inputs)', () => {
  assert.equal(demoDeterministicId('material:DEMO-MAT-0001'), demoDeterministicId('material:DEMO-MAT-0001'));
  assert.notEqual(demoDeterministicId('material:DEMO-MAT-0001'), demoDeterministicId('material:DEMO-MAT-0002'));
  assert.notEqual(demoMaterialId('DEMO-MAT-0001'), demoFormulaId('DEMO-MAT-0001'), 'namespacing by kind must prevent a material/formula id collision on the same code');
});

test('demoDeterministicId: output is shaped like a uuid column will accept', () => {
  const id = demoDeterministicId('anything');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('demoMaterialId is stable across repeated calls (simulates two separate processes agreeing with no coordination)', () => {
  for (let i = 0; i < MATERIAL_COUNT; i++) {
    const code = demoMaterialCodeAt(i);
    assert.equal(demoMaterialId(code), demoMaterialId(code));
  }
  // No two of the 60 codes collide.
  const ids = new Set(Array.from({ length: MATERIAL_COUNT }, (_, i) => demoMaterialId(demoMaterialCodeAt(i))));
  assert.equal(ids.size, MATERIAL_COUNT);
});

test('demoFormulaId / demoFormulaVersionId: stable, and a version id differs from its own formula id', () => {
  for (const def of DEMO_FORMULA_DEFS) {
    const formulaId = demoFormulaId(def.code);
    const versionId = demoFormulaVersionId(def.code, 1);
    assert.equal(formulaId, demoFormulaId(def.code));
    assert.equal(versionId, demoFormulaVersionId(def.code, 1));
    assert.notEqual(formulaId, versionId);
  }
  assert.notEqual(demoFormulaId(DEMO_FORMULA_DEFS[0]!.code), demoFormulaId(DEMO_FORMULA_DEFS[1]!.code));
});

test('demoFormulaIngredientPlan: deterministic, percentages sum to 100, every materialCode is one of the 60 demo materials', () => {
  const validCodes = new Set(Array.from({ length: MATERIAL_COUNT }, (_, i) => demoMaterialCodeAt(i)));
  for (let f = 0; f < DEMO_FORMULA_DEFS.length; f++) {
    const def = DEMO_FORMULA_DEFS[f]!;
    const planA = demoFormulaIngredientPlan(f, def.ingredientCount);
    const planB = demoFormulaIngredientPlan(f, def.ingredientCount);
    assert.deepEqual(planA, planB, 'two independent calls (standing in for the factory and vault phases) must produce byte-identical plans');
    assert.equal(planA.length, def.ingredientCount);
    assert.equal(planA.reduce((sum, p) => sum + p.percentage, 0), 100, `formula ${def.code}'s ingredient percentages must sum to 100`);
    for (const p of planA) {
      assert.ok(validCodes.has(p.materialCode), `${p.materialCode} is not one of the 60 demo material codes`);
      assert.equal(p.materialId, demoMaterialId(p.materialCode));
    }
    // sequenceNo is 1..n with no gaps/repeats.
    assert.deepEqual(planA.map((p) => p.sequenceNo).sort((a, b) => a - b), Array.from({ length: def.ingredientCount }, (_, i) => i + 1));
  }
});
