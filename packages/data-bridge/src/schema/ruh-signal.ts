/**
 * bridge.ruh_signal — the durable queue of Ruh's C3 signals toward ALEMBIC
 * (`POST /api/v1/internal/rawprod/ruh/signal`, migration scripts/migrations/2026-10-06-ruh.sql).
 *
 * One row per thing to tell ALEMBIC: `op = 'signal'` (an insight, or a person's override of a Ruh
 * warning, carried in `payload`) or `op = 'resolve'` (the insight under `dedupe_key` cleared).
 * A row stays until ALEMBIC answers 2xx (`delivered_at`): an unreachable or refusing ALEMBIC only
 * moves `next_attempt_at` out (exponential, capped) — nothing is dropped. A body ALEMBIC calls
 * permanently malformed is parked (`parked_at`), still kept, and visible on the Platform console.
 *
 * Dedupe: while undelivered, one pending row per (op, dedupe_key) — a detector that runs again
 * refreshes the pending payload instead of queueing a second copy (partial unique index).
 */
import { bigint, index, integer, jsonb, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { dictPk } from "@core/data-kernel";
import { bridge } from "./_schema.js";

export const ruhSignal = bridge.table(
  "ruh_signal",
  {
    ruhSignalId: dictPk("ruh_signal_id"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    op: varchar("op", { length: 10 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
    payload: jsonb("payload"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastHttpStatus: integer("last_http_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ruh_signal_pending_uq").on(t.op, t.dedupeKey).where(sql`${t.deliveredAt} IS NULL AND ${t.parkedAt} IS NULL`),
    uniqueIndex("ruh_signal_seq_uq").on(t.seq),
    index("ruh_signal_due_idx").on(t.nextAttemptAt).where(sql`${t.deliveredAt} IS NULL AND ${t.parkedAt} IS NULL`),
  ],
);
