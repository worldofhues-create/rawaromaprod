/**
 * platform cross-cutting tables (doc 10 §1) — kernel factories so the shape matches
 * every other cluster. platform does NOT hash-chain its audit log (only trust +
 * revenue do).
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { platform } from "./_schema.js";

/** platform.outbox — transactional outbox. */
export const outbox = outboxTable(platform);

/** platform.audit_events — append-only audit log (no hash-chain in platform). */
export const auditEvents = auditTable(platform);
