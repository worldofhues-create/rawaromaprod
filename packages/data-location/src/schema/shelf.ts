/**
 * Physical-shelf tables (lane produce, owner requirement + decisions 2026-09-29; migration
 * scripts/migrations/2026-09-29-produce.sql). The rack/shelf/bin codes themselves stay in the
 * Phase-1A hierarchy (warehouse → floor → zone → rack → shelf → bin, warehouse.ts) — warehouse
 * staff enter them in the app (the quick "Rack layout" entry creates a rack with its shelves and
 * bins in one go). These tables add what the hierarchy lacks:
 *
 *   rack_walk_order       the order a person walks the racks in — put-away and pick sheets and
 *                         the shelf display sort by it (a rack with no row sorts after, by code).
 *   shelf_task            one put-away / pick / move of a finished-good batch to or from a bin.
 *                         OPEN until done at the shelf (scan or type the bin code), then DONE.
 *   fg_bin_stock          which bin each finished-good batch is on, and how much — the "rack"
 *                         on the label, the shelf display and the pick allocation (FIFO) read it.
 *   pick_light_config     the pick-to-light controller (device-agnostic HTTP + HMAC, or the
 *                         built-in simulator), set in the app — no .env, no redeploy.
 *   pick_light_command    every light command, queued in the same transaction as the task it
 *                         belongs to and delivered by the worker (retry, fail closed).
 *   pick_light_sim_state  the simulator: which bins are lit, in which colour, for which task.
 *
 * Within-schema references are real FKs (bin_master, rack_master); the FG batch, SKU, UOM and
 * ALEMBIC requirement are id-only soft refs, as everywhere else.
 */
import { bigint, boolean, index, integer, jsonb, numeric, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { location } from "./_schema.js";
import { binMaster, rackMaster } from "./warehouse.js";

/** RACK_WALK_ORDER — walking sequence per rack (lower walks first). */
export const rackWalkOrder = location.table("rack_walk_order", {
  rackId: uuid("rack_id").primaryKey().references(() => rackMaster.rackId),
  walkSeq: integer("walk_seq").notNull(),
  updatedDt: timestamp("updated_dt", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar("updated_by", { length: 255 }),
});

/** SHELF_TASK — a put-away, pick or move at the shelves. status: OPEN | DONE | CANCELLED. */
export const shelfTask = location.table(
  "shelf_task",
  {
    shelfTaskId: dictPk("shelf_task_id"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    kind: varchar("kind", { length: 10 }).notNull(), // PUTAWAY | PICK | MOVE
    finishedGoodBatchId: uuid("finished_good_batch_id").notNull(), // soft ref → packaging.finished_good_batch_master
    productSkuId: uuid("product_sku_id"), // soft ref → packaging.product_sku
    qty: numeric("qty", { precision: 18, scale: 4 }).notNull(),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    fromBinId: uuid("from_bin_id").references(() => binMaster.binId),
    toBinId: uuid("to_bin_id").references(() => binMaster.binId),
    alembicRequirementId: uuid("alembic_requirement_id"), // soft ref → bridge.production_requirement
    reference: varchar("reference", { length: 100 }),
    priorityRank: integer("priority_rank"),
    completedBy: uuid("completed_by"), // soft ref → iam.user_master
    completedDt: timestamp("completed_dt", { withTimezone: true }),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("shelf_task_seq_uq").on(t.seq),
    index("shelf_task_status_idx").on(t.status, t.kind),
    index("shelf_task_fg_idx").on(t.finishedGoodBatchId),
    index("shelf_task_to_bin_idx").on(t.toBinId),
    index("shelf_task_from_bin_idx").on(t.fromBinId),
  ],
);

/** FG_BIN_STOCK — a finished-good batch's quantity on one bin. */
export const fgBinStock = location.table(
  "fg_bin_stock",
  {
    fgBinStockId: dictPk("fg_bin_stock_id"),
    finishedGoodBatchId: uuid("finished_good_batch_id").notNull(), // soft ref → packaging.finished_good_batch_master
    binId: uuid("bin_id").notNull().references(() => binMaster.binId),
    qty: numeric("qty", { precision: 18, scale: 4 }).notNull(),
    uomId: uuid("uom_id"), // soft ref → platform.uom_master
    putAwayDt: timestamp("put_away_dt", { withTimezone: true }).notNull().defaultNow(),
    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("fg_bin_stock_batch_bin_uq").on(t.finishedGoodBatchId, t.binId),
    index("fg_bin_stock_bin_idx").on(t.binId),
  ],
);

/** PICK_LIGHT_CONFIG — one row ('default'). mode: off | simulator | http. */
export const pickLightConfig = location.table("pick_light_config", {
  id: varchar("id", { length: 50 }).primaryKey().default("default"),
  mode: varchar("mode", { length: 20 }).notNull().default("off"),
  controllerUrl: text("controller_url"),
  hmacSecretSealed: text("hmac_secret_sealed"),
  configuredAt: timestamp("configured_at", { withTimezone: true }),
  configuredBy: varchar("configured_by", { length: 255 }),
});

/** PICK_LIGHT_COMMAND — the outbound light-command queue. status: PENDING | SENT | SIMULATED | PARKED | SKIPPED. */
export const pickLightCommand = location.table(
  "pick_light_command",
  {
    commandId: dictPk("command_id"),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    shelfTaskId: uuid("shelf_task_id"), // the task this light belongs to
    action: varchar("action", { length: 10 }).notNull(), // on | off
    body: jsonb("body").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    lastHttpStatus: integer("last_http_status"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pick_light_command_seq_uq").on(t.seq),
    index("pick_light_command_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

/** PICK_LIGHT_SIM_STATE — the simulator's lit bins, keyed "rack|shelf|bin". */
export const pickLightSimState = location.table("pick_light_sim_state", {
  locationKey: varchar("location_key", { length: 160 }).primaryKey(),
  rack: varchar("rack", { length: 50 }).notNull(),
  shelf: varchar("shelf", { length: 50 }),
  bin: varchar("bin", { length: 50 }),
  lit: boolean("lit").notNull().default(false),
  colour: varchar("colour", { length: 20 }),
  qty: numeric("qty", { precision: 18, scale: 4 }),
  shelfTaskId: uuid("shelf_task_id"),
  signatureOk: boolean("signature_ok"),
  lastCommand: jsonb("last_command"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
