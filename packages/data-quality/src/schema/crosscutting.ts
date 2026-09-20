/**
 * quality cross-cutting tables (data-conventions §1) — kernel factories so the shape
 * matches every other cluster. quality does NOT hash-chain its audit log (only formula
 * + sales chains do, per the plan §5).
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { quality } from "./_schema.js";

/** quality.outbox — transactional outbox (every state change records an event here). */
export const outbox = outboxTable(quality);

/** quality.audit_events — append-only audit log (no hash-chain in quality). */
export const auditEvents = auditTable(quality);
