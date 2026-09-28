/**
 * The main box's side of the Vault's compliance certificates (owner ruling 2026-09-28, item 2;
 * migration scripts/migrations/2026-09-28-compliance-documents.sql).
 *
 * The Vault never calls this box, and this box never opens the Vault database: the worker PULLS
 * newly calculated certificates over the signed internal channel
 * (`POST /internal/vault/compliance-certificates`, cursor = the Vault's certificate `seq`) and
 * keeps a copy here, then emits `compliance.certificate.calculated` toward ALEMBIC once per
 * (certificate, product whose product_master.formula_id is the certificate's formula).
 *
 *   compliance_certificate           the pulled certificate: kind, amendment, the calculated
 *                                    numbers, the opaque formula version ref, and formula_id —
 *                                    which this box already holds on product_master and uses only
 *                                    to find the products; it is never put on the bridge.
 *   compliance_certificate_emission  (certificate, product) already emitted — idempotency, and how
 *                                    a product linked to a formula LATER still gets the current
 *                                    certificate on the next sweep.
 *   vault_sync_cursor                the last Vault seq pulled (one row, id 'default').
 */
import { bigint, index, integer, jsonb, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { dictPk } from "@core/data-kernel";
import { bridge } from "./_schema.js";

export const complianceCertificate = bridge.table(
  "compliance_certificate",
  {
    certificateId: uuid("certificate_id").primaryKey(),
    vaultSeq: bigint("vault_seq", { mode: "number" }).notNull(),
    formulaId: uuid("formula_id").notNull(),
    formulaVersionRef: varchar("formula_version_ref", { length: 80 }).notNull(),
    // Lane produce: the version NUMBER ALEMBIC prints ("Calculated from formula v3", DOCS-001).
    // A number, not formula content; null for a certificate pulled before the Vault sent it.
    formulaVersionNumber: integer("formula_version_number"),
    kind: varchar("kind", { length: 10 }).notNull(),
    amendment: varchar("amendment", { length: 60 }),
    certValues: jsonb("cert_values").notNull(),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bridge_compliance_certificate_seq_uq").on(t.vaultSeq),
    index("bridge_compliance_certificate_formula_kind_idx").on(t.formulaId, t.kind, t.vaultSeq),
  ],
);

export const complianceCertificateEmission = bridge.table(
  "compliance_certificate_emission",
  {
    emissionId: dictPk("emission_id"),
    certificateId: uuid("certificate_id").notNull(),
    productId: uuid("product_id").notNull(),
    emittedAt: timestamp("emitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("bridge_compliance_certificate_emission_uq").on(t.certificateId, t.productId)],
);

export const vaultSyncCursor = bridge.table("vault_sync_cursor", {
  id: varchar("id", { length: 50 }).primaryKey(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
