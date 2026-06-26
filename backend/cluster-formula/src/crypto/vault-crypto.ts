/**
 * vault-crypto — pure AES-256-GCM seal/unseal of a formula ingredient's sensitive pair
 * ({ materialId, percentage }) under a per-formula DEK, plus a canonical serializer for the
 * audit hash chain. No DI, no key access here — the DEK is handed in by the service after
 * the `KmsPort` unwraps it, so these stay trivially testable and side-effect free.
 *
 * Ciphertext lands in three columns (the dict's [ENCRYPTED] mark): enc_payload (ct),
 * enc_iv, enc_tag — all base64. The structural columns (formula_version_id, sequence_no)
 * stay plaintext so the recipe SHAPE is queryable without ever decrypting the WHAT.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The three ciphertext columns persisted per sealed ingredient row. */
export interface Sealed {
  encPayload: string;
  encIv: string;
  encTag: string;
}

/** The sensitive payload that is NEVER stored in plaintext. */
export interface IngredientSecret {
  materialId: string;
  percentage: number;
}

/** Seal an ingredient secret under the formula's DEK. Fresh 96-bit iv per row. */
export function seal(secret: IngredientSecret, dek: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const pt = Buffer.from(JSON.stringify(secret), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return {
    encPayload: ct.toString('base64'),
    encIv: iv.toString('base64'),
    encTag: cipher.getAuthTag().toString('base64'),
  };
}

/** Unseal a row back to the secret. Throws (GCM tag) if any of the three columns was altered. */
export function unseal(sealed: Sealed, dek: Buffer): IngredientSecret {
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(sealed.encIv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.encTag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(sealed.encPayload, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString('utf8')) as IngredientSecret;
}

/** A new 256-bit data-encryption key for a formula. Wrapped by the KEK before it is stored. */
export function newDek(): Buffer {
  return randomBytes(32);
}

/**
 * Canonical, stable string for an audit row — feeds `KmsPort.macAudit(prevHash + canonical)`.
 * Uses `JSON.stringify` over a FIXED-ORDER tuple (not a raw delimiter join): JSON quotes and
 * escapes every string, so the encoding is injective — a value containing a separator can't be
 * crafted to collide with a different field layout. Covers chain_seq (so deletions are
 * detectable) plus every persisted security-relevant column (requestId/ip included).
 */
export function canonicalAudit(row: {
  chainSeq: bigint;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  occurredAt: string;
  requestId: string | null;
  ip: string | null;
}): string {
  return JSON.stringify([
    row.chainSeq.toString(),
    row.actorId,
    row.action,
    row.entityType,
    row.entityId,
    row.occurredAt,
    row.requestId,
    row.ip,
  ]);
}
