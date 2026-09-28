/**
 * bridge.production_requirement — RawProd's local projection of an ALEMBIC
 * ProductionRequirement (§25 of the master directive), keyed by the id ALEMBIC minted
 * (`alembic_requirement_id`), so an inbound event's `aggregate.id` looks this up directly
 * with no second mapping table. `org_id` is ALEMBIC's tenant id, carried for the day
 * RawProd serves more than one org; not yet used to scope reads (RawProd is single-org
 * today), kept honest rather than omitted so that day is an index add, not a migration.
 *
 * `mapped_sku` is a soft ref (plain text) to whatever `masterdata`/`packaging` calls this
 * SKU — RawProd, not ALEMBIC, is the authority on whether that SKU exists, and the
 * importer validates it exists before accepting (rejects with
 * ProductionRequirementRejectedMapping otherwise, never a guess).
 */
import { index, integer, jsonb, numeric, text, timestamp, uuid, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { dictPk, metaColumns } from "@core/data-kernel";
import { bridge } from "./_schema.js";

export const productionRequirement = bridge.table(
  "production_requirement",
  {
    productionRequirementId: dictPk("production_requirement_id"),

    alembicRequirementId: uuid("alembic_requirement_id").notNull(),
    orgId: uuid("org_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),

    orderRef: varchar("order_ref", { length: 100 }).notNull(),
    mappedSku: text("mapped_sku").notNull(),
    qty: numeric("qty").notNull(),
    uom: varchar("uom", { length: 20 }).notNull(),
    packSize: varchar("pack_size", { length: 50 }),
    neededBy: timestamp("needed_by", { withTimezone: true }).notNull(),
    priority: varchar("priority", { length: 20 }).notNull().default("normal"),

    // Lane produce (owner requirement 2026-09-29; migration 2026-09-29-produce.sql): the fields
    // ALEMBIC (lane/fulfil) adds to ProductionRequirementCreated/Changed. ALEMBIC ranks — RawProd
    // orders its production queue by priority_rank, then needed_by, then arrival, and never
    // re-ranks. order_value_inr is kept only to count/alert "high value" (>= ₹25,000).
    priorityRank: integer("priority_rank"),
    priorityReason: varchar("priority_reason", { length: 30 }),
    orderValueInr: numeric("order_value_inr", { precision: 18, scale: 2 }),
    orderRefs: jsonb("order_refs"), // string[] — every commercial order this requirement serves
    qtyKg: numeric("qty_kg", { precision: 18, scale: 4 }),
    lotPolicy: varchar("lot_policy", { length: 20 }),
    // Why the "Produce next" one-click plan could not proceed (e.g. NO_APPROVED_FORMULA), and when.
    produceBlockReason: varchar("produce_block_reason", { length: 60 }),
    produceBlockedAt: timestamp("produce_blocked_at", { withTimezone: true }),
    // Set once the requirement's "overdue" alert has been raised (so it is raised once).
    overdueAlertedAt: timestamp("overdue_alerted_at", { withTimezone: true }),

    // Mirrors the ALEMBIC lifecycle vocabulary exactly (requirement.ts on that side),
    // so a support engineer reading either database sees the same word for the same fact.
    lifecycleStatus: varchar("lifecycle_status", { length: 30 }).notNull().default("CREATED"),
    statusReason: text("status_reason"),

    // The productionOrderId this requirement is fulfilled by, once one exists. Soft ref
    // into `production.production_order` — set by the planning flow, not by the importer.
    productionOrderId: uuid("production_order_id"),

    lastAppliedVersion: numeric("last_applied_version").notNull().default("0"),
    // The last envelope version RawProd itself emitted TOWARD ALEMBIC for this
    // aggregate (Accepted=1, Scheduled=2, ...). A separate counter from
    // lastAppliedVersion above, which tracks the opposite direction.
    lastEmittedVersion: numeric("last_emitted_version").notNull().default("0"),

    ...metaColumns(),
  },
  (t) => [
    uniqueIndex("bridge_production_requirement_alembic_id_uq").on(t.alembicRequirementId),
    index("bridge_production_requirement_status_idx").on(t.lifecycleStatus),
    index("bridge_production_requirement_order_idx").on(t.orderRef),
    index("bridge_production_requirement_queue_idx").on(t.priorityRank, t.neededBy, t.createdDt),
  ],
);
