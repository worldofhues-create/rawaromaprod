/**
 * LocationLookupService — in-cluster implementation of the `LocationLookup` public port.
 * Provided under `LOCATION_LOOKUP` so consumers depend only on the interface (doc 06 §10).
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { LOCATION_DB, locationSchema, type LocationDb } from './location.tokens.js';
import type {
  LocationLookup,
  LocationRef,
  StorageLocationRef,
} from './public-api.js';

@Injectable()
export class LocationLookupService implements LocationLookup {
  constructor(@Inject(LOCATION_DB) private readonly db: LocationDb) {}

  async findLocation(locationId: string): Promise<LocationRef | null> {
    const { locationMaster } = locationSchema;
    const row = (
      await this.db
        .select({
          locationId: locationMaster.locationId,
          locationCode: locationMaster.locationCode,
          locationName: locationMaster.locationName,
          organizationId: locationMaster.organizationId,
        })
        .from(locationMaster)
        .where(eq(locationMaster.locationId, locationId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findStorageLocation(
    storageLocationId: string,
  ): Promise<StorageLocationRef | null> {
    const { storageLocationMaster } = locationSchema;
    const row = (
      await this.db
        .select({
          storageLocationId: storageLocationMaster.storageLocationId,
          storageLocationCode: storageLocationMaster.storageLocationCode,
          warehouseId: storageLocationMaster.warehouseId,
        })
        .from(storageLocationMaster)
        .where(eq(storageLocationMaster.storageLocationId, storageLocationId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
