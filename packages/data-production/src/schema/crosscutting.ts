/**
 * production cross-cutting tables (data-conventions §1) — kernel factories so the shape
 * matches every other cluster. production does NOT hash-chain its audit log (only the formula
 * vault chains, per the plan §5). The outbox carries production flow events (order created,
 * materials issued, oil batch produced) for downstream packaging/traceability.
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { production } from "./_schema.js";

/** production.outbox — transactional outbox (every state change records an event here). */
export const outbox = outboxTable(production);

/** production.audit_events — append-only audit log (no hash-chain in production). */
export const auditEvents = auditTable(production);
