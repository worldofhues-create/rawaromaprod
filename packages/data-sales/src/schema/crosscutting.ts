/**
 * sales cross-cutting tables (data-conventions §1) — kernel factories so the shape matches
 * every other cluster. sales does NOT hash-chain its audit log. The outbox carries sales flow
 * events (sales order confirmed, dispatch created) for downstream traceability.
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { sales } from "./_schema.js";

/** sales.outbox — transactional outbox (every state change records an event here). */
export const outbox = outboxTable(sales);

/** sales.audit_events — append-only audit log (no hash-chain in sales). */
export const auditEvents = auditTable(sales);
