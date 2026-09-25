/**
 * bridge.outbox_delivery — per-event delivery state for `bridge.outbox` (RawProd → ALEMBIC),
 * OPS_GREEN §17 (P1 poison event). `bridge.outbox` is the shared @core/data-kernel
 * `outboxTable()` shape every cluster uses (id/type/payload/published_at/attempts/seq), so the
 * state the bridge relay needs and no other outbox does lives BESIDE it, one row per outbox
 * event that has failed at least once:
 *
 *   next_attempt_at   exponential backoff (2 s doubling, capped at 30 min) for a TRANSIENT
 *                     failure — the relay used to re-POST every 2 s for ever.
 *   parked_at/_reason the relay gave up: 'permanent' (ALEMBIC refused the content — a 4xx or
 *                     `permanent: true`) after ONE attempt, or 'max_attempts' after 12.
 *   discarded_*       an operator took it out of the queue for good, with a reason.
 *
 * Soft ref to `bridge.outbox.id` (same schema, but the outbox is a kernel-shaped table other
 * code drains and prunes; a hard FK would couple its lifecycle to this one).
 */
import { integer, text, timestamp, uuid, varchar, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { bridge } from "./_schema.js";

export const outboxDelivery = bridge.table(
  "outbox_delivery",
  {
    outboxId: uuid("outbox_id").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    lastHttpStatus: integer("last_http_status"),
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    parkedReason: varchar("parked_reason", { length: 20 }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    discardedBy: varchar("discarded_by", { length: 255 }),
    discardReason: text("discard_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bridge_outbox_delivery_parked_idx")
      .on(t.parkedAt)
      .where(sql`${t.parkedAt} IS NOT NULL AND ${t.discardedAt} IS NULL`),
  ],
);
