/**
 * Sealing the bridge's shared HMAC secret so the database alone is worth nothing.
 *
 * The admin-entered value (`bridge.connector_config.hmac_secret_sealed`) is AES-256-GCM
 * ciphertext; the key that opens it (`BRIDGE_HMAC_KEK`) lives only in this deployment's
 * environment — a dump, a replica, or a support session's `SELECT *` yields sealed bytes
 * and nothing else. Same rationale as ALEMBIC's `packages/db/src/secret-box.ts`, scoped
 * down to this one secret: RawProd has no general credential vault today, and building
 * one is out of this bridge's scope, but the one secret this channel needs is not going
 * in cleartext for that reason.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AAD = Buffer.from('bridge:rawprod_alembic:hmac_secret', 'utf8');

export class NoBridgeKek extends Error {
  constructor() {
    super(
      'BRIDGE_HMAC_KEK is not set — base64 of 32 random bytes. Until it is, the bridge ' +
        'HMAC secret cannot be stored, and it is not stored in the clear.',
    );
    this.name = 'NoBridgeKek';
  }
}

function kek(): Buffer {
  const raw = process.env.BRIDGE_HMAC_KEK;
  if (!raw) throw new NoBridgeKek();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) throw new NoBridgeKek();
  return key;
}

/** Seals `value`. Returns a self-describing base64 blob: iv || tag || ciphertext. */
export function sealSecret(value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Opens a blob `sealSecret` produced. Returns null on any failure (wrong key, altered
 *  bytes, wrong context) rather than throwing — the caller treats "cannot open" the same
 *  as "not configured", never surfacing which of the two it was. */
export function openSecret(sealed: string): string | null {
  try {
    const buf = Buffer.from(sealed, 'base64');
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', kek(), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
