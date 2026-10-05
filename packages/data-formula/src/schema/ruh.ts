/**
 * formula.ruh_override — the Vault's record of a person continuing past a Ruh warning on a Vault
 * action (owner rulings 2026-10-06; migration scripts/migrations/2026-10-06-ruh.sql). Today: one
 * person approving many recipes at once while IFRA/allergen calculations show warnings.
 *
 * COUNTS ONLY. The action, the person's typed reason and the risks as Ruh worded them (numbers of
 * versions / formulas) — never a formula name, code, ingredient, material or percentage. The main
 * box pulls new rows over the signed internal channel (cursor = `seq`) and turns each into an
 * urgent insight for admins and a C3 override signal to ALEMBIC (which emails them); the Vault
 * box itself never calls out. The same event is also on the hash-chained `formula.audit_events`.
 */
import { bigint, jsonb, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk } from "@core/data-kernel";
import { formula } from "./_schema.js";

export const ruhOverride = formula.table(
  "ruh_override",
  {
    ruhOverrideId: dictPk("ruh_override_id"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    action: varchar("action", { length: 60 }).notNull(),
    actorId: uuid("actor_id").notNull(), // soft ref → iam.user_master (main box)
    reason: text("reason").notNull(),
    risks: jsonb("risks").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ruh_override_seq_uq").on(t.seq)],
);
