/**
 * bridge schema barrel — the ALEMBIC↔RawProd channel (§24-27 of the master directive).
 * drizzle.config.ts points `schema` here.
 */
export { bridge } from "./_schema.js";
export { productionRequirement } from "./production-requirement.js";
export { inboundEvent } from "./inbound-event.js";
export { connectorConfig } from "./connector-config.js";
export { outbox, auditEvents } from "./crosscutting.js";
