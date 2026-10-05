/**
 * One check for every signed request ALEMBIC sends this box outside the event webhook — the
 * Facts API (PB-06) and the factory catalogue (FACTORY-SETUP). Moved here verbatim from
 * `FactsService.verifySignature` (S3 security review item 5) so the two endpoints cannot drift:
 *
 *   - the signed material is `${timestamp}.${nonce}.${rawBody}`, HMAC-SHA256 with the shared
 *     secret sealed in `bridge.connector_config` (the one an admin entered; no second secret);
 *   - a timestamp older than 300 s, or more than 5 s in the future, is refused even with a
 *     perfect signature;
 *   - the nonce is spent in `bridge.facts_nonce` (an atomic unique insert shared by every
 *     process) ONLY after the signature verified — an unauthenticated caller cannot burn nonces,
 *     and a replay of a captured request is refused.
 *
 * An unconfigured or disabled connector verifies nothing: unconfigured is not open.
 */
import { eq, lt } from 'drizzle-orm';
import { bridgeSchema, type BridgeDb } from './bridge.tokens.js';
import { openSecret } from './secret-box.js';
import { verifyBody } from './signing.js';

const { connectorConfig, factsNonce } = bridgeSchema;

export const MAX_TIMESTAMP_AGE_S = 300;
export const CLOCK_SKEW_TOLERANCE_S = 5;

export async function verifySignedBridgeRequest(
  bridgeDb: BridgeDb,
  rawBody: string,
  header: string | null,
  timestamp: string | null,
  nonce: string | null,
): Promise<boolean> {
  if (!timestamp || !nonce) return false;
  const timestampSec = Number(timestamp);
  if (!Number.isFinite(timestampSec)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - timestampSec > MAX_TIMESTAMP_AGE_S) return false; // too old
  if (timestampSec - nowSec > CLOCK_SKEW_TOLERANCE_S) return false; // from the future

  const config = (await bridgeDb.select().from(connectorConfig)
    .where(eq(connectorConfig.id, 'default')).limit(1))[0];
  const secret = config?.hmacSecretSealed ? openSecret(config.hmacSecretSealed) : null;
  if (!config?.enabled || !secret) return false;

  if (!verifyBody(`${timestamp}.${nonce}.${rawBody}`, secret, header)) return false;
  return consumeNonce(bridgeDb, nonce, timestampSec + MAX_TIMESTAMP_AGE_S);
}

/** Postgres-backed single use: `INSERT ... ON CONFLICT DO NOTHING` is atomic across processes. */
async function consumeNonce(bridgeDb: BridgeDb, nonce: string, expiresAtSec: number): Promise<boolean> {
  try {
    await bridgeDb.delete(factsNonce).where(lt(factsNonce.expiresAt, new Date()));
  } catch {
    // Best-effort sweep — never let it block or falsely allow the single-use check below.
  }
  const inserted = await bridgeDb
    .insert(factsNonce)
    .values({ nonce, expiresAt: new Date(expiresAtSec * 1000) })
    .onConflictDoNothing()
    .returning({ nonce: factsNonce.nonce });
  return inserted.length > 0;
}
