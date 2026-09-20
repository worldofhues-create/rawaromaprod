/**
 * platform cluster — PUBLIC API (doc 01 §0, doc 06 §10).
 *
 * platform is a root config plane: other clusters cache its data via events + a startup
 * snapshot and have NO hot-path sync dependency on it (doc 06 §10 matrix). The only
 * surface we expose is a read port for the rare cold lookup (e.g. resolving a master
 * label or a geo region by id outside the event-fed cache). Inject by token.
 */

export interface GeoRegionRef {
  id: string;
  typeKey: string;
  name: string;
  parentId: string | null;
}

export interface MasterItemRef {
  id: string;
  typeKey: string;
  key: string;
  label: string;
}

/** Cold read port into platform reference data. */
export interface PlatformLookup {
  /** Resolve a geo region by id (cold path; hot reads use the cluster's own cache). */
  findRegion(regionId: string): Promise<GeoRegionRef | null>;
  /** Resolve a master item by id. */
  findMasterItem(itemId: string): Promise<MasterItemRef | null>;
}

/** DI token for `PlatformLookup`. */
export const PLATFORM_LOOKUP = Symbol('PLATFORM_LOOKUP');
