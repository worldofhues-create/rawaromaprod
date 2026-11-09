/**
 * FLOOR-FIX-7 — owner decision (Alembic docs/design-brief/brand/design_handoff_sales_desk/
 * CLAUDE_CODE_REPLY.md): production for a product with no formula on file is blocked, fail-closed,
 * with "Formula not on file". Exactly those words, for both ways a formula can be missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_MESSAGES } from '@ra/cluster-production';

test('a missing formula reads exactly "Formula not on file"', () => {
  assert.equal(BLOCK_MESSAGES.NO_APPROVED_FORMULA, 'Formula not on file');
  assert.equal(BLOCK_MESSAGES.NO_FORMULA_LINK, 'Formula not on file');
});
