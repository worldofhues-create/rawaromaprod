/**
 * bridge cross-cutting tables (data-conventions §1) — kernel factories so the shape
 * matches every other cluster.
 *
 * `outbox` here carries ONLY events bound for ALEMBIC (RawProd →
 * ProductionRequirementAccepted/Scheduled/.../Dispatched, per §26) — it is not drained by
 * the internal `OutboxPublisher`/bus RawProd uses for in-process fan-out; `bridge`'s own
 * relay service (backend/api/src/bridge/relay.service.ts) drains it over the signed HTTP
 * channel instead and reuses this table's existing `publishedAt`/`attempts` columns to
 * mean "delivered to ALEMBIC" / "delivery attempts" rather than "dispatched to the bus" —
 * the same shape, the same meaning one level up, not a new mechanism.
 */
import { auditTable, outboxTable } from "@core/data-kernel";
import { bridge } from "./_schema.js";

/** bridge.outbox — events bound for ALEMBIC. */
export const outbox = outboxTable(bridge);

/** bridge.audit_events — append-only audit log (no hash-chain; this is not the air-gap
 *  relay, which is the only channel in this codebase that hash-chains). */
export const auditEvents = auditTable(bridge);
