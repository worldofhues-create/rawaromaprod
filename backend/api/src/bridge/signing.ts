/** HMAC-SHA256 over the raw request body — the wire-level half of the bridge contract.
 *  Identical algorithm to ALEMBIC's `packages/domain/src/bridge/signing.ts` by
 *  construction: the two must agree byte-for-byte or nothing verifies. */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signBody(rawBody: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

export function verifyBody(rawBody: string, secret: string, header: string | null | undefined): boolean {
  if (!header) return false;
  const expected = signBody(rawBody, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(header, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
