/**
 * inventory cross-cutting tables (data-conventions §1) — kernel factories so the shape
 * matches every other cluster. inventory does NOT hash-chain its audit log (only formula
 * + sales chains do, per the plan §5).
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { inventory } from "./_schema.js";

/** inventory.outbox — transactional outbox (every state change records an event here). */
export const outbox = outboxTable(inventory);

/** inventory.audit_events — append-only audit log (no hash-chain in inventory). */
export const auditEvents = auditTable(inventory);
