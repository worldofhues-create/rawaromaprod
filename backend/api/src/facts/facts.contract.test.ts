/**
 * facts.contract — pure validation + the closed allow-list "never formula/vault" guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FACT_KINDS, FACT_KIND_PERMISSION, isKnownFactKind, isNeverResolvable,
  validateFactsQueryBody,
} from "./facts.contract.js";

test("every published fact kind has a required permission and none touches formula/vault", () => {
  for (const kind of FACT_KINDS) {
    assert.equal(typeof FACT_KIND_PERMISSION[kind], "string");
    assert.equal(isNeverResolvable(kind), false, `${kind} must not look formula/vault-shaped`);
    assert.doesNotMatch(FACT_KIND_PERMISSION[kind], /formula|vault/i);
  }
});

test("isNeverResolvable refuses a kind that names or merely resembles formula/vault data", () => {
  for (const kind of [
    "formula_composition", "formula_percentages", "vault_material_search",
    "wrapped_dek", "material_kek", "staff_password_reset", "provider_otp",
  ]) {
    assert.equal(isNeverResolvable(kind), true, kind);
  }
});

test("isKnownFactKind is true only for the published allow-list", () => {
  assert.equal(isKnownFactKind("production_requirement_status"), true);
  assert.equal(isKnownFactKind("formula_composition"), false);
  assert.equal(isKnownFactKind("anything_else"), false);
});

test("validateFactsQueryBody accepts a well-formed request", () => {
  const r = validateFactsQueryBody({
    factKind: "production_requirement_status",
    params: { orderRef: "RAC-1234" },
    caller: { staffId: "staff-1", roles: ["production"] },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.body.factKind, "production_requirement_status");
    assert.deepEqual(r.body.caller, { staffId: "staff-1", roles: ["production"] });
  }
});

test("validateFactsQueryBody refuses a missing/malformed caller", () => {
  const r = validateFactsQueryBody({
    factKind: "production_requirement_status",
    params: {},
    caller: { staffId: "staff-1" }, // no roles array
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.problems.includes("bad_caller"));
});

test("validateFactsQueryBody refuses a non-string param value", () => {
  const r = validateFactsQueryBody({
    factKind: "material_availability",
    params: { materialQuery: 12345 },
    caller: { staffId: "staff-1", roles: [] },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.problems.includes("bad_params"));
});

test("validateFactsQueryBody refuses a non-object body", () => {
  const r = validateFactsQueryBody(null);
  assert.equal(r.ok, false);
});
