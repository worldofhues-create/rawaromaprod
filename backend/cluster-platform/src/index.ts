/**
 * @core/cluster-platform — the platform cluster module + its public port.
 */
export { PlatformModule } from './platform.module.js';
export { PlatformFlagsService } from './flags/flags.service.js';
export {
  type GeoRegionRef,
  type MasterItemRef,
  type PlatformLookup,
  PLATFORM_LOOKUP,
} from './public-api.js';
