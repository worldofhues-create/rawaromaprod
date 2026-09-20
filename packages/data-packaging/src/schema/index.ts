/**
 * packaging schema barrel (Phase-1A). drizzle.config points here.
 */
export { packaging } from "./_schema.js";
export {
  productCategoryMaster,
  productMaster,
  productSku,
  packagingMaterialMaster,
  packagingBomMaster,
} from "./product.js";
export {
  packageOrder,
  packageOrderItem,
  fillingSession,
  fillingSessionDetails,
} from "./order.js";
export {
  finishedGoodBatchMaster,
  finishedGoodsBatchConsumption,
  finishedGoodReservation,
} from "./batch.js";
export { outbox, auditEvents } from "./crosscutting.js";
