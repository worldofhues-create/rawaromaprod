/**
 * @core/cluster-platform — the platform cluster module + its public port.
 */
export { PlatformModule } from './platform.module.js';
export { PlatformFlagsService } from './flags/flags.service.js';
/* B09 (STUB-075): the Platform console's audit-chain reading recomputes this chain on the main box. */
export { chainHash, type ChainRow, type StoredChainRow } from './flags/flag-chain.js';
export {
  type GeoRegionRef,
  type MasterItemRef,
  type PlatformLookup,
  PLATFORM_LOOKUP,
} from './public-api.js';
