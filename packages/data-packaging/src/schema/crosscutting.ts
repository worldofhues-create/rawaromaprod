/**
 * packaging cross-cutting tables (data-conventions §1) — kernel factories so the shape matches
 * every other cluster. packaging does NOT hash-chain its audit log. The outbox carries packaging
 * flow events (package order created, filling done, FG batch produced) for downstream sales.
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { packaging } from "./_schema.js";

/** packaging.outbox — transactional outbox (every state change records an event here). */
export const outbox = outboxTable(packaging);

/** packaging.audit_events — append-only audit log (no hash-chain in packaging). */
export const auditEvents = auditTable(packaging);
