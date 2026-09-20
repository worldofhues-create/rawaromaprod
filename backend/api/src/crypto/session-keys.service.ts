/**
 * SessionKeysService — the server half of the encrypted-channel handshake.
 *
 * A client does an ephemeral ECDH (P-256) handshake: it sends its public key, we generate ours,
 * compute the shared secret, derive an AES-256-GCM key via HKDF-SHA256, and keep the key in
 * memory under a random `keyId` (the only thing the client re-sends). The shared key never
 * crosses the wire — only public keys do. All subsequent traffic is sealed with this key, so the
 * DevTools Network tab shows nothing but ciphertext.
 *
 * In-memory store (single instance). Keys expire after TTL; this is the channel key, NOT the
 * auth session — authentication still happens via the JWT carried (encrypted) inside the tunnel.
 */
import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

interface KeyEntry {
  key: Buffer;
  expires: number;
}

const TTL_MS = 1000 * 60 * 60 * 8; // 8h channel lifetime
const HKDF_INFO = Buffer.from('ra-session-v1');

@Injectable()
export class SessionKeysService {
  private readonly store = new Map<string, KeyEntry>();

  /** Handshake: take the client's raw P-256 public key (base64), return ours + a keyId. */
  handshake(clientPubB64: string): { keyId: string; serverPub: string } {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const clientPub = Buffer.from(clientPubB64, 'base64');
    const shared = ecdh.computeSecret(clientPub); // 32-byte X coordinate
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32));
    const keyId = randomBytes(18).toString('base64url');
    this.prune();
    this.store.set(keyId, { key, expires: Date.now() + TTL_MS });
    return { keyId, serverPub: ecdh.getPublicKey().toString('base64') };
  }

  private get(keyId: string): Buffer | null {
    const e = this.store.get(keyId);
    if (!e) return null;
    if (e.expires < Date.now()) {
      this.store.delete(keyId);
      return null;
    }
    return e.key;
  }

  /** Decrypt a base64(iv|ciphertext|tag) blob under the channel key. Returns null on any failure. */
  open(keyId: string, blobB64: string): string | null {
    const key = this.get(keyId);
    if (!key) return null;
    try {
      const buf = Buffer.from(blobB64, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(buf.length - 16);
      const ct = buf.subarray(12, buf.length - 16);
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Seal a utf8 string → base64(iv|ciphertext|tag) under the channel key. */
  seal(keyId: string, plaintext: string): string | null {
    const key = this.get(keyId);
    if (!key) return null;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
  }

  private prune(): void {
    if (this.store.size < 500) return;
    const now = Date.now();
    for (const [k, v] of this.store) if (v.expires < now) this.store.delete(k);
  }
}
