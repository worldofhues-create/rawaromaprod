/**
 * location cluster — PUBLIC API (doc 01 §0, doc 06 §10).
 *
 * The ONLY surface other clusters may import from location. Cross-cluster talk is either an
 * outbox event or a DI'd interface declared here — never a deep import. inventory/production
 * resolve a site or a storage bin by id at cold path via this port; hot reads use their own
 * event-fed cache. Inject by token; implementations live inside the cluster.
 */

/** A minimal site view (LOCATION_MASTER) exposed to other clusters. */
export interface LocationRef {
  locationId: string;
  locationCode: string | null;
  locationName: string | null;
  organizationId: string | null;
}

/** A minimal storage-location view (STORAGE_LOCATION_MASTER) exposed to other clusters. */
export interface StorageLocationRef {
  storageLocationId: string;
  storageLocationCode: string | null;
  warehouseId: string | null;
}

/** Cold read port into location reference data. */
export interface LocationLookup {
  /** Resolve a site by id, or null if absent. */
  findLocation(locationId: string): Promise<LocationRef | null>;
  /** Resolve a storage location by id, or null if absent. */
  findStorageLocation(storageLocationId: string): Promise<StorageLocationRef | null>;
}

/** DI token for `LocationLookup`. Consumers: `@Inject(LOCATION_LOOKUP)`. */
export const LOCATION_LOOKUP = Symbol('LOCATION_LOOKUP');
