/**
 * platform schema barrel (Phase-1A reference masters). drizzle.config points here.
 */
export { platform } from "./_schema.js";
export {
  countryMaster,
  currencyMaster,
  languageMaster,
  timezoneMaster,
  addressMaster,
  geoLocationMaster,
  contactMaster,
} from "./geo.js";
export { documentTypeMaster, documentMaster } from "./document.js";
export {
  uomTypeMaster,
  uomMaster,
  uomConversionMaster,
  brandMaster,
} from "./uom.js";
