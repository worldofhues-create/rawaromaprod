/**
 * bridge.connector_config — the self-service half of the channel: ALEMBIC's inbound
 * webhook URL (non-secret) and the shared HMAC secret, entered by an admin through the
 * API, never a `.env` value and never a constant in this repo (same requirement as
 * ALEMBIC's own `rawprod_bridge` connector). One row (`id = 'default'`) is enough today —
 * RawProd serves one org — kept as a keyed row rather than a true singleton table so a
 * second org is an INSERT, not a schema change.
 *
 * `hmac_secret_sealed` is AES-256-GCM ciphertext (backend/api/src/bridge/secret-box.ts),
 * bound to this row's `id` as associated data. The key that opens it lives only in the
 * deployment's environment (`BRIDGE_HMAC_KEK`) — a copy of this table's row is useless
 * without it, same rationale as ALEMBIC's `connector_secret`.
 */
import { boolean, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { bridge } from "./_schema.js";

export const connectorConfig = bridge.table("connector_config", {
  id: varchar("id", { length: 50 }).primaryKey().default("default"),
  enabled: boolean("enabled").notNull().default(false),
  webhookUrl: text("webhook_url"),
  // Base64 of the AES-256-GCM sealed bytes (backend/api/src/bridge/secret-box.ts) — a
  // plain `text` column because it is already ciphertext; the encoding is incidental.
  hmacSecretSealed: text("hmac_secret_sealed"),
  configuredAt: timestamp("configured_at", { withTimezone: true }),
  configuredBy: varchar("configured_by", { length: 255 }),
});
