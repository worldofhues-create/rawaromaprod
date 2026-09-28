/**
 * PRODUCE_ALERT (lane produce, owner requirement 2026-09-29; migration
 * scripts/migrations/2026-09-29-produce.sql) — the alert log behind the consoles' live
 * badge/toast/sound: a new high-value or overdue production requirement, a batch that failed QC
 * (labelling blocked), a requirement blocked because no approved formula exists for its product.
 *
 * Append-only. `seq` is the consoles' cursor ("everything after the last one I showed").
 * `roles` names the role codes the alert is for (owner sees every alert); `dedupe_key` makes each
 * alert fire once (e.g. `overdue:<requirement id>`). Text only — never formula content: a
 * formula alert names the PRODUCT and SKU, never a formula name, material or percentage.
 */
import { bigint, index, text, timestamp, uuid, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { dictPk } from "@core/data-kernel";
import { production } from "./_schema.js";

export const produceAlert = production.table(
  "produce_alert",
  {
    produceAlertId: dictPk("produce_alert_id"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    kind: varchar("kind", { length: 40 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    roles: text("roles").array().notNull(),
    refType: varchar("ref_type", { length: 40 }),
    refId: uuid("ref_id"), // soft ref (requirement / batch COA / FG batch)
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("produce_alert_dedupe_uq").on(t.dedupeKey),
    uniqueIndex("produce_alert_seq_uq").on(t.seq),
    index("produce_alert_created_idx").on(t.createdAt),
  ],
);
