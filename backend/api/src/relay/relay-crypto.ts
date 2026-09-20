/**
 * Relay integrity primitives — Ed25519 sign/verify + SHA-256, over the canonical package manifest.
 * Keys are base64 DER (pkcs8 private / spki public) from RELAY_SIGNING_KEY / RELAY_VERIFY_KEY.
 * Nothing here touches the DB or the KEK — this is transport integrity only.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Sign a canonical string with the base64-DER pkcs8 private key → base64 signature. */
export function signCanonical(signingKeyB64: string, canonical: string): string {
  const key = createPrivateKey({ key: Buffer.from(signingKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, Buffer.from(canonical, 'utf8'), key).toString('base64');
}

/** Verify a base64 signature over a canonical string with the base64-DER spki public key. */
export function verifyCanonical(verifyKeyB64: string, canonical: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(verifyKeyB64, 'base64'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
