/**
 * STOCK-FIX-RP (STK-27): a verifier's typed weight is accepted only with a second person's signed
 * check. Floor tests that type a weight get one here: a platform.typed_weight_check row already signed
 * by a supervisor who is not the typist, for exactly that figure, as ScaleService.signTypedCheck leaves
 * it. What those tests assert about verification is unchanged.
 */
import { randomUUID } from 'node:crypto';
import { testClient } from './db.js';

export async function signedTyped(mg: number, typist: { userId: string }): Promise<{ source: 'typed'; weightCheckId: string }> {
  const id = randomUUID();
  await testClient()`insert into platform.typed_weight_check (check_id, station, mg, reason, typed_by, status, signed_by, signed_role, signed_at)
    values (${id}, 'Floor', ${mg}, 'test fixture: scale not reading', ${typist.userId}, 'APPROVED', ${randomUUID()}, 'supervisor', now())`;
  return { source: 'typed', weightCheckId: id };
}
