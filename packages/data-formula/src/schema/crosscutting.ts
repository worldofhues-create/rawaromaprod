/**
 * formula cross-cutting tables. The audit log is HASH-CHAINED (hashChain: true) — the
 * vault writes its own access-audit row IN THE SAME TRANSACTION as every actual-formula
 * read/decrypt (a throwing insert, not the fire-and-forget global interceptor), so no
 * un-audited read is possible. The chain is tamper-evident (row_hash = H(prev || row)).
 * Outbox payloads here carry ids/aliases ONLY — never real formula data.
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { formula } from "./_schema.js";

/** formula.outbox — transactional outbox (alias/version events only; no real formula data). */
export const outbox = outboxTable(formula);

/** formula.audit_events — append-only, HASH-CHAINED access log. */
export const auditEvents = auditTable(formula, { hashChain: true });
