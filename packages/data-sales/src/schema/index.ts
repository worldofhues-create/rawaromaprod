/**
 * sales schema barrel (Phase-1A). drizzle.config points here.
 */
export { sales } from "./_schema.js";
export { customerMaster, transporterMaster } from "./customers.js";
export { salesOrder, salesOrderItems } from "./orders.js";
export { dispatchMaster, dispatchItems } from "./dispatch.js";
export { outbox, auditEvents } from "./crosscutting.js";
