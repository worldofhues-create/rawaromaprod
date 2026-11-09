/**
 * FLOOR-FIX-3 — a TYPED weight (not a stable scale reading) needs a second person. The packer asks,
 * a verifier, supervisor or admin who is not the packer signs, and the weight is accepted once, for
 * that station and that exact figure. The check row is the audit record: who typed, who signed, as
 * what role, when, and what it was used for.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { ensureSchema, testClient, principal, closeTestClient } from '../../../test-support/db.js';
import { ScaleService } from '../floor-ops/scale.service.js';

let scales: ScaleService;
before(async () => { await ensureSchema(); scales = new ScaleService(testClient()); });
after(closeTestClient);

test('typed weight: refused alone; signed by a different verifier it is accepted once; the sign-off is audited', async () => {
  const st = `TW ${randomUUID().slice(0, 6)}`;
  const packer = principal({ userId: randomUUID(), roles: ['packing'] });
  const verifier = principal({ userId: randomUUID(), roles: ['verifier'] });
  const picker = principal({ userId: randomUUID(), roles: ['picker'] });

  await assert.rejects(() => scales.resolveWeight({ mg: 1234, weightSource: 'typed' }, st, packer), /second person/i);
  const c = await scales.requestTypedCheck({ station: st, mg: 1234, reason: 'scale off for calibration' }, packer);
  assert.equal(c.status, 'PENDING');
  await assert.rejects(() => scales.resolveWeight({ mg: 1234, weightSource: 'typed', weightCheckId: c.checkId }, st, packer), /not signed/i);
  await assert.rejects(() => scales.signTypedCheck(c.checkId, packer), /someone else/i);
  await assert.rejects(() => scales.signTypedCheck(c.checkId, picker), /verifier|supervisor/i);
  const signed = await scales.signTypedCheck(c.checkId, verifier);
  assert.equal(signed.status, 'APPROVED');
  assert.equal(signed.signedBy, verifier.userId);
  assert.equal(signed.signedRole, 'verifier');
  await assert.rejects(() => scales.resolveWeight({ mg: 1235, weightSource: 'typed', weightCheckId: c.checkId }, st, packer), /does not match/i);
  await assert.rejects(() => scales.resolveWeight({ mg: 1234, weightSource: 'typed', weightCheckId: c.checkId }, 'Elsewhere', packer), /station/i);
  const w = await scales.resolveWeight({ mg: 1234, weightSource: 'typed', weightCheckId: c.checkId }, st, packer, 'unit U-1');
  assert.deepEqual(w, { mg: 1234, weightSource: 'typed', scaleReadingId: null, weightCheckId: c.checkId });
  await assert.rejects(() => scales.resolveWeight({ mg: 1234, weightSource: 'typed', weightCheckId: c.checkId }, st, packer), /already used/i);
  const [row] = await testClient()`select typed_by::text, signed_by::text, signed_role, status, used_for, signed_at is not null as s from platform.typed_weight_check where check_id = ${c.checkId}::uuid`;
  assert.deepEqual({ ...row }, { typed_by: packer.userId, signed_by: verifier.userId, signed_role: 'verifier', status: 'USED', used_for: 'unit U-1', s: true });
});
