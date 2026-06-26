/**
 * procurement cross-cutting tables (data-conventions §1) — kernel factories so the shape
 * matches every other cluster. procurement does NOT hash-chain its audit log (only formula
 * + sales chains do, per the plan §5).
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { procurement } from "./_schema.js";

/** procurement.outbox — transactional outbox. */
export const outbox = outboxTable(procurement);

/** procurement.audit_events — append-only audit log (no hash-chain in procurement). */
export const auditEvents = auditTable(procurement);
