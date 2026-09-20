/**
 * PlatformLookupService — in-cluster implementation of the `PlatformLookup` public port.
 * Provided under `PLATFORM_LOOKUP` so consumers depend only on the interface.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PLATFORM_DB, platformSchema, type PlatformDb } from '@core/backend-kernel';
import type {
  GeoRegionRef,
  MasterItemRef,
  PlatformLookup,
} from './public-api.js';

@Injectable()
export class PlatformLookupService implements PlatformLookup {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  async findRegion(regionId: string): Promise<GeoRegionRef | null> {
    const { geoRegions } = platformSchema;
    const row = (
      await this.db
        .select({
          id: geoRegions.id,
          typeKey: geoRegions.typeKey,
          name: geoRegions.name,
          parentId: geoRegions.parentId,
        })
        .from(geoRegions)
        .where(eq(geoRegions.id, regionId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findMasterItem(itemId: string): Promise<MasterItemRef | null> {
    const { masterItems } = platformSchema;
    const row = (
      await this.db
        .select({
          id: masterItems.id,
          typeKey: masterItems.typeKey,
          key: masterItems.key,
          label: masterItems.label,
        })
        .from(masterItems)
        .where(eq(masterItems.id, itemId))
        .limit(1)
    )[0];
    return row ?? null;
  }
}
