/**
 * S3 security review item 5 — replay store for the Facts API's signed-request nonce
 * (`FactsService.verifySignature` / `FactsController.query`). The HMAC signature already
 * proves the caller is ALEMBIC; the timestamp+nonce pair on top of it closes the replay
 * window a bare body-signature leaves open — a captured, still-validly-signed request body
 * could otherwise be re-POSTed indefinitely. `nonce` is a fresh random value ALEMBIC's
 * `rawprod-facts-client.ts` mints per request (never reused deliberately), so a genuine retry
 * always carries a NEW nonce; a `unique` violation here means the same nonce was presented
 * twice, which is only possible via replay (or a client bug, which this rail must not reward
 * with a second successful answer either way).
 */
import { timestamp, varchar } from "drizzle-orm/pg-core";
import { bridge } from "./_schema.js";

export const factsNonce = bridge.table("facts_nonce", {
  nonce: varchar("nonce", { length: 255 }).primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
