/**
 * location schema barrel (Phase-1A sites + warehouse hierarchy). drizzle.config points here.
 */
export { location } from "./_schema.js";
export { locationTypeMaster, locationMaster } from "./location.js";
export {
  warehouseTypeMaster,
  warehouseMaster,
  floorMaster,
  zoneTypeMaster,
  zoneMaster,
  rackMaster,
  shelfMaster,
  binMaster,
} from "./warehouse.js";
export {
  storageLocationTypeMaster,
  storageLocationStatusMaster,
  storageLocationMaster,
} from "./storage.js";
