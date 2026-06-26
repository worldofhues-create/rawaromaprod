/**
 * platform feature flags — the control plane (doc 10 §4). `flags` (definition,
 * registered from nt-contracts) × `flag_states` (per-env state + targeting) drive the
 * kill-switch; every change writes `flag_audit` with a MANDATORY reason. Critical
 * flags gate on 2FA step-up.
 */
import {
  index,
  jsonb,
  boolean,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { baseColumns } from "@core/data-kernel";
import { platform } from "./_schema.js";

/**
 * flags — definition. `key` = `portal.module.feature` UK. `kind` boolean|variant.
 * `is_critical` (auth/payments) → 2FA step-up to change. `default_state` on|off|
 * degraded.
 */
export const flags = platform.table(
  "flags",
  {
    ...baseColumns(),
    key: text("key").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("boolean"),
    isCritical: boolean("is_critical").notNull().default(false),
    defaultState: text("default_state").notNull().default("off"),
  },
  (t) => [uniqueIndex("flags_key_uq").on(t.key)],
);

/**
 * flag_states — per-env (staging|prod) resolved state + targeting jsonb (role|portal|
 * city|percent). FK flag_id (in-schema). One state row per (flag, env).
 */
export const flagStates = platform.table(
  "flag_states",
  {
    ...baseColumns(),
    flagId: uuid("flag_id")
      .notNull()
      .references(() => flags.id, { onDelete: "cascade" }),
    env: text("env").notNull(),
    state: text("state").notNull(),
    targeting: jsonb("targeting"),
  },
  (t) => [
    uniqueIndex("flag_states_flag_env_uq").on(t.flagId, t.env),
    index("flag_states_env_idx").on(t.env),
  ],
);

/**
 * flag_audit — append-only change log for flags; `reason` is MANDATORY (notNull).
 * `actor_id` is an id-only soft ref to iam.users. FK flag_id (in-schema).
 */
export const flagAudit = platform.table(
  "flag_audit",
  {
    ...baseColumns(),
    flagId: uuid("flag_id")
      .notNull()
      .references(() => flags.id, { onDelete: "cascade" }),
    env: text("env").notNull(),
    oldState: text("old_state"),
    newState: text("new_state").notNull(),
    reason: text("reason").notNull(),
    actorId: uuid("actor_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("flag_audit_flag_idx").on(t.flagId),
    index("flag_audit_env_idx").on(t.env),
    index("flag_audit_at_idx").on(t.at),
  ],
);
