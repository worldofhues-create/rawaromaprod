/**
 * Always-on Ruh (owner rulings 2026-10-06; migration scripts/migrations/2026-10-06-ruh.sql).
 *
 *   ruh_insight   what Ruh noticed, predicted or was told: one row per insight, addressed to
 *                 RawProd ROLES (owner sees all), with the console + deep link that opens the
 *                 record, an optional prediction and its basis, and the person's decision
 *                 (snoozed / done / dismissed). `dedupe_key` is unique while the insight is open
 *                 or snoozed, so a detector that runs again updates the same row. `rev` moves on
 *                 every change: the consoles poll "anything after rev N?".
 *   ruh_setting   Ruh's thresholds, one jsonb value per key, changed in the app (no .env).
 *
 * Text only, written by Ruh's own detectors and guards: never formula content (a Vault insight
 * is a count), never a secret.
 */
import { bigint, boolean, index, jsonb, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { dictPk } from "@core/data-kernel";
import { platform } from "./_schema.js";

export const ruhInsight = platform.table(
  "ruh_insight",
  {
    ruhInsightId: dictPk("ruh_insight_id"),
    rev: bigint("rev", { mode: "number" }).notNull(),
    kind: varchar("kind", { length: 80 }).notNull(),
    severity: varchar("severity", { length: 10 }).notNull(),
    audienceRoles: text("audience_roles").array().notNull(),
    console: varchar("console", { length: 12 }).notNull(),
    subject: jsonb("subject").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    deepLink: text("deep_link"),
    prediction: jsonb("prediction"),
    source: varchar("source", { length: 20 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
    mirror: boolean("mirror").notNull().default(false),
    status: varchar("status", { length: 12 }).notNull().default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    actedBy: uuid("acted_by"), // soft ref → iam.user_master
    actedAt: timestamp("acted_at", { withTimezone: true }),
    actNote: text("act_note"),
    lastDetectedAt: timestamp("last_detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ruh_insight_open_dedupe_uq").on(t.dedupeKey).where(sql`${t.status} in ('open', 'snoozed')`),
    index("ruh_insight_status_idx").on(t.status, t.severity),
    index("ruh_insight_rev_idx").on(t.rev),
    index("ruh_insight_dedupe_idx").on(t.dedupeKey, t.createdAt),
  ],
);

export const ruhSetting = platform.table("ruh_setting", {
  settingKey: varchar("setting_key", { length: 80 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by"), // soft ref → iam.user_master
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
