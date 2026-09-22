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
import { index, numeric, text, timestamp, uuid, uniqueIndex, varchar } from "drizzle-orm/pg-core";
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
  ],
);
