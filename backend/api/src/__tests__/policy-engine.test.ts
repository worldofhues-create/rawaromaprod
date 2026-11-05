/**
 * PROD-A-1 — the rules engine (production-floor plan §12.0), pure part: precedence on the scope
 * ladder, else-if order inside a rung, "otherwise", and hold when nothing resolves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, validateBody, type PolicyBody } from '../policy/policy-engine.js';

const shortfall: PolicyBody = {
  rules: [
    { id: 'g1', scope: 'global', when: [{ field: 'vendor_tier', op: 'eq', value: 'A' }], then: { shortPct: 25 } },
    { id: 'f1', scope: 'material_family', when: [{ field: 'material_family', op: 'eq', value: 'naturals' }], then: { shortPct: 10 } },
    { id: 'v1', scope: 'vendor', when: [{ field: 'vendor', op: 'eq', value: 'Givaudan' }], then: { shortPct: 15 } },
    { id: 'r1', scope: 'record', when: [{ field: 'record_id', op: 'eq', value: 'PO-123' }], then: { shortPct: 50 } },
  ],
  hasDefault: true,
  defaultValue: { shortPct: 20 },
};

test('scope ladder: a record rule beats vendor, which beats family, which beats a general rule', () => {
  const all = { record_id: 'PO-123', vendor: 'Givaudan', material_family: 'naturals', vendor_tier: 'A' };
  assert.equal((evaluateRules(shortfall, all) as { ruleId: string }).ruleId, 'r1');
  assert.equal((evaluateRules(shortfall, { ...all, record_id: 'PO-9' }) as { ruleId: string }).ruleId, 'v1');
  assert.equal((evaluateRules(shortfall, { ...all, record_id: 'PO-9', vendor: 'X' }) as { ruleId: string }).ruleId, 'f1');
  assert.equal((evaluateRules(shortfall, { vendor_tier: 'A' }) as { ruleId: string }).ruleId, 'g1');
});

test('otherwise: the default, with no rule id, and the explanation says so', () => {
  const r = evaluateRules(shortfall, { vendor: 'Other' });
  assert.equal(r.resolved, true);
  assert.deepEqual((r as { value: unknown }).value, { shortPct: 20 });
  assert.equal((r as { ruleId: unknown }).ruleId, null);
  assert.match(r.explain, /otherwise/i);
});

test('the explanation names the rule that won and its condition', () => {
  const r = evaluateRules(shortfall, { vendor: 'Givaudan' });
  assert.match(r.explain, /Rule 3: vendor = Givaudan/);
});

test('else-if: inside one rung the first matching rule wins', () => {
  const body: PolicyBody = {
    rules: [
      { id: 'a', scope: 'global', when: [{ field: 'days_late', op: 'gt', value: 3 }, { field: 'customer_tier', op: 'eq', value: 'trade' }], then: 'top' },
      { id: 'b', scope: 'global', when: [{ field: 'channel', op: 'eq', value: 'storefront' }], then: 'alternate' },
    ],
    hasDefault: true, defaultValue: 'alternate',
  };
  assert.equal((evaluateRules(body, { days_late: 5, customer_tier: 'TRADE', channel: 'storefront' }) as { value: unknown }).value, 'top');
  assert.equal((evaluateRules(body, { days_late: 2, customer_tier: 'trade', channel: 'storefront' }) as { ruleId: unknown }).ruleId, 'b');
});

test('a comparison against an unknown value is not true (unknown lateness is not "late")', () => {
  const body: PolicyBody = { rules: [{ id: 'a', scope: 'global', when: [{ field: 'days_late', op: 'gt', value: 3 }], then: 1 }], hasDefault: false };
  assert.equal(evaluateRules(body, {}).resolved, false);
  assert.equal(evaluateRules(body, { days_late: 'soon' }).resolved, false);
  assert.equal(evaluateRules(body, { days_late: '4' }).resolved, true);
});

test('no match and no default: unresolved (hold and ask), never a guess', () => {
  const r = evaluateRules({ rules: [], hasDefault: false }, { anything: 1 });
  assert.equal(r.resolved, false);
  assert.match(r.explain, /hold/i);
});

test('validation: refuses bad scopes, ops, missing THEN, duplicate ids and a record rule naming no record', () => {
  const p = validateBody({
    rules: [
      { id: 'x', scope: 'planet', when: [], then: 1 },
      { id: 'x', scope: 'global', when: [{ field: 'a', op: 'like', value: 1 }], then: 1 },
      { id: 'y', scope: 'global', when: [{ field: 'a', op: 'gt', value: 'three' }] },
      { id: 'z', scope: 'record', when: [], then: 1 },
    ],
    hasDefault: true,
  });
  const text = p.join(' | ');
  for (const want of ['unknown scope', 'repeats the id', 'unknown test', 'not a number', 'no THEN', 'does not name it', '"otherwise" value is missing']) {
    assert.ok(text.includes(want), `expected "${want}" in: ${text}`);
  }
  assert.deepEqual(validateBody(shortfall), []);
});
