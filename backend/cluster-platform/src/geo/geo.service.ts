/**
 * GeoService — autocomplete over the geo region tree (doc 06 §2). Uses a trigram
 * similarity match on `geo_regions.name` (the `geo_regions_name_trgm_idx` GIN index),
 * optionally filtered by region type, ordered by similarity. Returns lightweight suggest
 * items with a breadcrumb path the UI shows ("Vijay Nagar, Indore, MP").
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { PLATFORM_DB, platformSchema, type PlatformDb } from '@core/backend-kernel';

export interface GeoSuggestQuery {
  q: string;
  typeKey?: string;
  limit: number;
}

export interface GeoSuggestItem {
  id: string;
  typeKey: string;
  name: string;
  path: string;
}

@Injectable()
export class GeoService {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /** Trigram suggest. `pg_trgm`'s `%` operator + `similarity()` ranking. */
  async suggest(query: GeoSuggestQuery): Promise<GeoSuggestItem[]> {
    const { geoRegions } = platformSchema;
    const term = query.q;

    const conditions = [
      eq(geoRegions.isActive, true),
      sql`${geoRegions.name} % ${term}`,
    ];
    if (query.typeKey) conditions.push(eq(geoRegions.typeKey, query.typeKey));

    const rows = await this.db
      .select({
        id: geoRegions.id,
        typeKey: geoRegions.typeKey,
        name: geoRegions.name,
        parentId: geoRegions.parentId,
        sim: sql<number>`similarity(${geoRegions.name}, ${term})`,
      })
      .from(geoRegions)
      .where(and(...conditions))
      .orderBy(desc(sql`similarity(${geoRegions.name}, ${term})`))
      .limit(query.limit);

    // Resolve a 1-level breadcrumb (parent name) — deep paths are a read-model concern.
    const parentIds = rows
      .map((r) => r.parentId)
      .filter((id): id is string => id !== null);
    const parents = await this.namesFor(parentIds);

    return rows.map((r) => ({
      id: r.id,
      typeKey: r.typeKey,
      name: r.name,
      path: r.parentId ? `${r.name}, ${parents.get(r.parentId) ?? ''}`.trim() : r.name,
    }));
  }

  private async namesFor(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (ids.length === 0) return map;
    const { geoRegions } = platformSchema;
    const rows = await this.db
      .select({ id: geoRegions.id, name: geoRegions.name })
      .from(geoRegions)
      .where(inArray(geoRegions.id, ids));
    for (const r of rows) map.set(r.id, r.name);
    return map;
  }
}
