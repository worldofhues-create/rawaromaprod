/**
 * masterdata cross-cutting tables (data-conventions §1) — kernel factories so the
 * shape matches every other cluster. masterdata does NOT hash-chain its audit log
 * (only formula + sales chains do, per the plan §5).
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { masterdata } from "./_schema.js";

/** masterdata.outbox — transactional outbox (every state change records an event here). */
export const outbox = outboxTable(masterdata);

/** masterdata.audit_events — append-only audit log (no hash-chain in masterdata). */
export const auditEvents = auditTable(masterdata);
