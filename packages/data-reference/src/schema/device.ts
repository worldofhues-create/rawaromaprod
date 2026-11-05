/**
 * Production floor devices (lane pf-c, plan section 2 and 12.4/12.5; migration
 * scripts/migrations/2026-11-05-pfc-floor.sql).
 *
 *   device_master   a printer, TV, kiosk tablet or scale, bound to ONE station. Not a user.
 *   device_pairing  the 6-digit code (sha-256 only), valid 10 minutes, single use.
 *   device_token    the station-scoped device token (sha-256 only), revocable.
 *   print_job       one label/document as a template definition; the print agent renders it.
 *   scale_reading   stable readings only, integer milligrams.
 *   floor_alert     station alerts (printer offline, maceration complete, shipment held).
 */
import { bigint, boolean, index, integer, jsonb, text, timestamp, uniqueIndex, uuid, varchar, char } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { dictPk } from "@core/data-kernel";
import { platform } from "./_schema.js";

export const deviceMaster = platform.table(
  "device_master",
  {
    deviceId: dictPk("device_id"),
    kind: varchar("kind", { length: 20 }).notNull(),
    station: varchar("station", { length: 80 }).notNull(),
    site: varchar("site", { length: 80 }),
    name: varchar("name", { length: 120 }).notNull(),
    status: varchar("status", { length: 12 }).notNull().default("pending"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("device_master_station_idx").on(t.station, t.kind)],
);

export const devicePairing = platform.table(
  "device_pairing",
  {
    pairingId: dictPk("pairing_id"),
    deviceId: uuid("device_id").notNull().references(() => deviceMaster.deviceId),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("device_pairing_open_code_uq").on(t.codeHash).where(sql`${t.usedAt} is null`)],
);

export const deviceToken = platform.table(
  "device_token",
  {
    deviceTokenId: dictPk("device_token_id"),
    deviceId: uuid("device_id").notNull().references(() => deviceMaster.deviceId),
    station: varchar("station", { length: 80 }).notNull(),
    tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("device_token_device_idx").on(t.deviceId)],
);

export const printJob = platform.table(
  "print_job",
  {
    printJobId: dictPk("print_job_id"),
    deviceId: uuid("device_id"),
    station: varchar("station", { length: 80 }).notNull(),
    labelKind: varchar("label_kind", { length: 30 }).notNull(),
    subjectRef: varchar("subject_ref", { length: 120 }),
    template: jsonb("template").notNull(),
    status: varchar("status", { length: 10 }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    reprintOf: uuid("reprint_of"),
    reprintReason: text("reprint_reason"),
    requestedBy: uuid("requested_by"),
    printedAt: timestamp("printed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("print_job_pull_idx").on(t.deviceId, t.status, t.nextAttemptAt),
    index("print_job_subject_idx").on(t.labelKind, t.subjectRef),
  ],
);

export const scaleReading = platform.table(
  "scale_reading",
  {
    scaleReadingId: dictPk("scale_reading_id"),
    deviceId: uuid("device_id").notNull().references(() => deviceMaster.deviceId),
    station: varchar("station", { length: 80 }).notNull(),
    mg: bigint("mg", { mode: "number" }).notNull(),
    stable: boolean("stable").notNull(),
    raw: varchar("raw", { length: 200 }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scale_reading_device_idx").on(t.deviceId, t.readAt)],
);

export const floorAlert = platform.table(
  "floor_alert",
  {
    floorAlertId: dictPk("floor_alert_id"),
    kind: varchar("kind", { length: 40 }).notNull(),
    station: varchar("station", { length: 80 }),
    subjectType: varchar("subject_type", { length: 40 }),
    subjectId: uuid("subject_id"),
    title: text("title").notNull(),
    body: text("body"),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    ackedBy: uuid("acked_by"),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("floor_alert_open_uq").on(t.dedupeKey).where(sql`${t.clearedAt} is null`)],
);
