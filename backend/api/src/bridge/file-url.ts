/**
 * FACTORY-DOCS — the signed, expiring link ALEMBIC fetches a GC-MS PDF from (`qc.gcms.attached`
 * `file.url`). Pure: no I/O.
 *
 * The link names the report, the exact bytes (their SHA-256) and an expiry, and is signed with a key
 * DERIVED from the bridge connector's HMAC secret: the secret ALEMBIC already shares is never used
 * directly for a second purpose, and rotating it retires every outstanding link at once. The relay
 * mints a fresh link at each delivery attempt (relay.service.ts), so the lifetime only has to cover
 * ALEMBIC's fetch on receipt, never the relay's backoff.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const GCMS_FILE_PATH = '/v1/bridge/files/gcms';
const PURPOSE = 'rawprod:qc.gcms.attached:file-url:v1';

function fileKey(connectorSecret: string): Buffer {
  return createHmac('sha256', connectorSecret).update(PURPOSE).digest();
}

function mac(connectorSecret: string, reportId: string, sha256: string, exp: number): string {
  return createHmac('sha256', fileKey(connectorSecret)).update(`${reportId}.${sha256}.${exp}`).digest('base64url');
}

/** `<base>/v1/bridge/files/gcms/<reportId>?sha=<sha256>&exp=<unix s>&sig=<mac>` */
export function signGcmsFileUrl(input: {
  baseUrl: string; reportId: string; sha256: string; nowMs: number; ttlSeconds: number; connectorSecret: string;
}): string {
  const exp = Math.floor(input.nowMs / 1000) + input.ttlSeconds;
  const base = input.baseUrl.replace(/\/+$/, '');
  const sig = mac(input.connectorSecret, input.reportId, input.sha256, exp);
  return `${base}${GCMS_FILE_PATH}/${encodeURIComponent(input.reportId)}?sha=${input.sha256}&exp=${exp}&sig=${sig}`;
}

export type GcmsLinkCheck = { ok: true } | { ok: false; reason: 'malformed' | 'expired' | 'bad_signature' };

/** Verifies a link's parts. Expiry is checked before the signature only to say WHICH refusal it
 *  was; both refuse. */
export function verifyGcmsFileLink(input: {
  reportId: string; sha256: unknown; exp: unknown; sig: unknown; nowMs: number; connectorSecret: string;
}): GcmsLinkCheck {
  const { reportId } = input;
  const sha = typeof input.sha256 === 'string' ? input.sha256 : '';
  const sig = typeof input.sig === 'string' ? input.sig : '';
  const exp = typeof input.exp === 'string' && /^\d{1,12}$/.test(input.exp) ? Number(input.exp) : NaN;
  if (!/^[0-9a-f-]{36}$/i.test(reportId) || !/^[0-9a-f]{64}$/.test(sha) || !sig || !Number.isFinite(exp)) {
    return { ok: false, reason: 'malformed' };
  }
  if (exp * 1000 <= input.nowMs) return { ok: false, reason: 'expired' };
  const want = Buffer.from(mac(input.connectorSecret, reportId, sha, exp), 'utf8');
  const got = Buffer.from(sig, 'utf8');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}
