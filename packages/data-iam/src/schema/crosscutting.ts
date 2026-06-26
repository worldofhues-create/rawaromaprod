/**
 * iam cross-cutting tables (doc 10 §1) — built from the kernel factories so the
 * shape matches every other cluster. iam does NOT hash-chain its audit log (only
 * trust + revenue do), so `auditTable` is called without hashChain.
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { iam } from "./_schema.js";

/** iam.outbox — transactional outbox. */
export const outbox = outboxTable(iam);

/** iam.audit_events — append-only audit log (no hash-chain in iam). */
export const auditEvents = auditTable(iam);
