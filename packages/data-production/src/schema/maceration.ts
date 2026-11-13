/**
 * Maceration (lane pf-c, plan section 8; migration scripts/migrations/2026-11-05-pfc-floor.sql).
 *
 *   maceration_setting  per formula (soft ref): required, min/max days, freeze/chill-filter step.
 *   maceration_run      one open run per oil batch: QC 1 PASS -> maceration -> freeze -> QC 2.
 *                       While a run is open the batch cannot ship, become FG, or be reserved.
 *   maceration_event    the append-only log of a run.
 */
import { boolean, index, integer, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { dictPk } from "@core/data-kernel";
import { production } from "./_schema.js";

export const macerationSetting = production.table("maceration_setting", {
  formulaId: uuid("formula_id").primaryKey(), // soft ref → formula.formula_master (Vault)
  required: boolean("required").notNull().default(false),
  minDays: integer("min_days").notNull(),
  maxDays: integer("max_days").notNull(),
  freezeRequired: boolean("freeze_required").notNull().default(false),
  freezeNote: varchar("freeze_note", { length: 300 }),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const macerationRun = production.table(
  "maceration_run",
  {
    macerationRunId: dictPk("maceration_run_id"),
    oilBatchId: uuid("oil_batch_id").notNull(),
    formulaId: uuid("formula_id"),
    status: varchar("status", { length: 16 }).notNull().default("MACERATING"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    minDays: integer("min_days").notNull(),
    // PROM-2: null = no maximum set (the branch rule sets none and no formula setting applies).
    maxDays: integer("max_days"),
    extendDays: integer("extend_days").notNull().default(0),
    freezeRequired: boolean("freeze_required").notNull().default(false),
    qc1ProductionQcId: uuid("qc1_production_qc_id").notNull(),
    freezeDoneAt: timestamp("freeze_done_at", { withTimezone: true }),
    freezeDoneBy: uuid("freeze_done_by"),
    alarmAt: timestamp("alarm_at", { withTimezone: true }),
    earlyReleaseAt: timestamp("early_release_at", { withTimezone: true }),
    earlyReleaseBy: uuid("early_release_by"),
    earlyReleaseReason: text("early_release_reason"),
    restartCount: integer("restart_count").notNull().default(0),
    // PROM-2 (migration 2026-11-16-prom-2-rest-rule): the branch rule this run rests under, the
    // two-person early release (early_release_by asks, early_release_approved_by approves, never the
    // same person), and on close the days actually rested.
    ruleDays: integer("rule_days"),
    ruleVersion: integer("rule_version"),
    ruleSource: varchar("rule_source", { length: 20 }),
    earlyReleaseRequestedAt: timestamp("early_release_requested_at", { withTimezone: true }),
    earlyReleaseReasonCode: varchar("early_release_reason_code", { length: 40 }),
    earlyReleaseApprovedBy: uuid("early_release_approved_by"),
    daysRested: integer("days_rested"),
    restShort: boolean("rest_short"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("maceration_run_open_uq").on(t.oilBatchId).where(sql`${t.status} = 'MACERATING'`)],
);

export const macerationEvent = production.table(
  "maceration_event",
  {
    macerationEventId: dictPk("maceration_event_id"),
    macerationRunId: uuid("maceration_run_id").notNull().references(() => macerationRun.macerationRunId),
    event: varchar("event", { length: 30 }).notNull(),
    note: text("note"),
    performedBy: uuid("performed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("maceration_event_run_idx").on(t.macerationRunId, t.createdAt)],
);
