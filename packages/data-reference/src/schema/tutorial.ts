/**
 * TUTORIAL_PROGRESS (ticket G4 — in-app tutorial engine): one row per (user, tutorial track,
 * lesson). Written by backend/api/src/tutorial/tutorial.service.ts via raw SQL against the
 * shared PG_CLIENT pool (a single small table — see that file's own header for why it skips a
 * dedicated Drizzle client/module the way the rest of this package's tables get one). This
 * definition exists so `pnpm db:push` provisions the table for real and so
 * backend/test-support/schema-guard.test.ts (lane F5's dead-table guard) recognizes
 * `platform.tutorial_progress` as real, not dead SQL — column-for-column identical to
 * scripts/migrations/2026-09-24-tutorial-system.sql. `user_id` is left an id-only reference
 * (no `.references()`), matching every other table in this file: no cross-schema FK, per this
 * package's own `_schema.ts` header ("extraction-safe modular monolith").
 */
import { integer, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

export const tutorialProgress = platform.table(
  "tutorial_progress",
  {
    tutorialProgressId: dictPk("tutorial_progress_id"),
    userId: uuid("user_id").notNull(),
    role: varchar("role", { length: 60 }).notNull(),
    lessonId: varchar("lesson_id", { length: 120 }).notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    tutorialVersion: integer("tutorial_version").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [uniqueIndex("tutorial_progress_user_role_lesson_uq").on(t.userId, t.role, t.lessonId)],
);
