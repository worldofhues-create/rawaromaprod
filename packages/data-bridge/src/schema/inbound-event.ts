/**
 * bridge.inbound_event — the idempotency/ordering ledger for events arriving FROM
 * ALEMBIC (ProductionRequirementCreated/Changed/Cancelled), per §26 and
 * docs/bridge/EVENT_CONTRACT.md "Idempotency, replay, ordering". Mirrors ALEMBIC's own
 * `bridge_inbound_event` table exactly in shape, because the same idempotency
 * mechanism — PK on `event_id`, `processed_at`/`parked_reason` distinguishing applied
 * from parked — has to be true on both ends of a bidirectional channel or "duplicate
 * delivery" would mean something different depending which side received it.
 */
import { index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bridge } from "./_schema.js";

export const inboundEvent = bridge.table(
  "inbound_event",
  {
    // The envelope's own event_id IS the primary key — the entire dedupe mechanism.
    eventId: uuid("event_id").primaryKey(),

    version: integer("version").notNull(),
    type: text("type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),

    processedAt: timestamp("processed_at", { withTimezone: true }),
    parkedReason: text("parked_reason"),
  },
  (t) => [
    index("bridge_inbound_event_unprocessed_idx").on(t.receivedAt),
    index("bridge_inbound_event_aggregate_idx").on(t.aggregateId, t.version),
  ],
);
