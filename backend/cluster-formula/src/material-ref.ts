/**
 * Keyed material references — how a formula line names its material on the wire between the
 * Formula Vault and the main app box without carrying the material_id (or an alias) itself.
 *
 *   ref = base64url( HMAC-SHA256( K, lower(material_id) ) ),
 *   K   = HMAC-SHA256( INTERNAL_BRIDGE_KEY, "rawprod/vault/material-ref/v1" )
 *
 * Both boxes already hold INTERNAL_BRIDGE_KEY (it signs every call on the internal channel); K is a
 * purpose-separated key derived from it, so a ref is never a request signature and vice versa. The
 * Vault computes the ref from the sealed material_id; the main box resolves it by computing the ref
 * of each of ITS OWN masterdata.material rows (production-vault-port.ts). To anyone without the key
 * (anything that sees the plain-HTTP private-network traffic) a ref is opaque — unlike an alias name
 * — and the main box learns nothing it does not already store (it keeps material_id on every
 * production_order_ingredients row).
 *
 * Why not the RM alias (floor code)? Resolving material_id -> alias inside the Vault needs a call
 * BACK into the main box's (since retired) material-facts bridge (MAIN_API_INTERNAL_URL), a path production and demo
 * never had (no MAIN_API_INTERNAL_URL in vault.env, the main API is not reachable from the vault
 * box, and nginx does not proxy /internal/). A keyed ref needs only the main -> vault channel that
 * already exists; the main box turns it into the floor code from its own masterdata.
 */
import { createHmac } from 'node:crypto';

const PURPOSE = 'rawprod/vault/material-ref/v1';

/** The material-ref key, derived from the shared INTERNAL_BRIDGE_KEY. */
export function materialRefKey(internalBridgeKey: string): Buffer {
  if (!internalBridgeKey) throw new Error('INTERNAL_BRIDGE_KEY is required to derive the material-ref key');
  return createHmac('sha256', internalBridgeKey).update(PURPOSE).digest();
}

/** The keyed reference of one material id (case-normalised, so any spelling of a uuid agrees). */
export function materialRef(key: Buffer, materialId: string): string {
  return createHmac('sha256', key).update(materialId.trim().toLowerCase()).digest('base64url');
}
