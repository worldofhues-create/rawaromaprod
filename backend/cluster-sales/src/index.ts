/**
 * @ra/cluster-sales — the sales cluster module + its public port + DB token. The order +
 * dispatch flows emit sales.order.created / sales.order.confirmed / sales.dispatch.created via
 * the transactional outbox; the worker drains that outbox onto the bus for downstream
 * (inventory / fulfilment) consumers.
 */
export { SalesModule } from './sales.module.js';
export { SALES_DB, type SalesDb } from './sales.tokens.js';
export { salesEvents } from './sales.events.js';
export {
  type SalesOrderRef,
  type DispatchRef,
  type SalesLookup,
  SALES_LOOKUP,
} from './public-api.js';
