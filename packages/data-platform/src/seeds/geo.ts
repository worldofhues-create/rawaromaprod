/**
 * platform geo seed data (doc 10 §4 + §11 P0).
 *
 * geo_region_types for India: country→state→district→tehsil→village (rural) and
 * district→city→ward→municipality→locality (urban). Plus launch-city Indore region
 * rows (country → state Madhya Pradesh → district Indore → city Indore + a few
 * localities). Centroids are approximate WGS-84 lon/lat as EWKT; boundaries left null
 * (loaded later from LGD/OSM). Idempotent: types keyed by `key`, regions keyed by
 * (type_key, code|name).
 */

/** India administrative region-type classification (rural + urban branches). */
export const INDIA_REGION_TYPES: ReadonlyArray<{
  key: string;
  name: string;
  displayOrder: number;
  typicalParent: string | null;
}> = [
  { key: "country", name: "Country", displayOrder: 0, typicalParent: null },
  { key: "state", name: "State / UT", displayOrder: 1, typicalParent: "country" },
  { key: "district", name: "District", displayOrder: 2, typicalParent: "state" },
  // Rural branch
  { key: "tehsil", name: "Tehsil / Taluka", displayOrder: 3, typicalParent: "district" },
  { key: "village", name: "Village", displayOrder: 4, typicalParent: "tehsil" },
  // Urban branch
  { key: "city", name: "City", displayOrder: 3, typicalParent: "district" },
  { key: "ward", name: "Ward", displayOrder: 4, typicalParent: "city" },
  { key: "municipality", name: "Municipality", displayOrder: 4, typicalParent: "city" },
  { key: "locality", name: "Locality", displayOrder: 5, typicalParent: "ward" },
];

/**
 * Launch-city Indore region rows. Hierarchy expressed by `parentKey` (a synthetic
 * stable key used only by the seeder to resolve parent_id). `code` is the LGD/census
 * code where known. centroid is EWKT `SRID=4326;POINT(lon lat)`.
 */
export interface SeedRegion {
  /** synthetic stable key (seed-only) to wire parent_id. */
  seedKey: string;
  parentKey: string | null;
  typeKey: string;
  name: string;
  code: string | null;
  /** EWKT point or null. */
  centroid: string | null;
}

export const INDORE_REGIONS: ReadonlyArray<SeedRegion> = [
  {
    seedKey: "in",
    parentKey: null,
    typeKey: "country",
    name: "India",
    code: "IN",
    centroid: "SRID=4326;POINT(78.9629 20.5937)",
  },
  {
    seedKey: "in-mp",
    parentKey: "in",
    typeKey: "state",
    name: "Madhya Pradesh",
    code: "23",
    centroid: "SRID=4326;POINT(78.6569 22.9734)",
  },
  {
    seedKey: "in-mp-indore-dist",
    parentKey: "in-mp",
    typeKey: "district",
    name: "Indore",
    code: "23-indore",
    centroid: "SRID=4326;POINT(75.8333 22.7167)",
  },
  {
    seedKey: "in-mp-indore-city",
    parentKey: "in-mp-indore-dist",
    typeKey: "city",
    name: "Indore",
    code: "indore-city",
    centroid: "SRID=4326;POINT(75.8577 22.7196)",
  },
  // A handful of well-known Indore localities (P0 seed; more added as data).
  {
    seedKey: "in-indore-vijay-nagar",
    parentKey: "in-mp-indore-city",
    typeKey: "locality",
    name: "Vijay Nagar",
    code: null,
    centroid: "SRID=4326;POINT(75.8937 22.7533)",
  },
  {
    seedKey: "in-indore-rau",
    parentKey: "in-mp-indore-city",
    typeKey: "locality",
    name: "Rau",
    code: null,
    centroid: "SRID=4326;POINT(75.7847 22.6360)",
  },
  {
    seedKey: "in-indore-old-palasia",
    parentKey: "in-mp-indore-city",
    typeKey: "locality",
    name: "Old Palasia",
    code: null,
    centroid: "SRID=4326;POINT(75.8895 22.7244)",
  },
  {
    seedKey: "in-indore-bhawarkua",
    parentKey: "in-mp-indore-city",
    typeKey: "locality",
    name: "Bhawarkua",
    code: null,
    centroid: "SRID=4326;POINT(75.8682 22.6868)",
  },
];
