/**
 * PostGIS geometry column helpers — SRID 4326 (WGS-84 lon/lat), doc 10 §1 "Geo".
 *
 * Why customType (and not drizzle's built-in `geometry`)
 * -----------------------------------------------------
 * drizzle-orm's `geometry()` only models `geometry(Point, 4326)` and maps it to a
 * `[lon, lat]` tuple. doc 10 needs Polygon AND MultiPolygon (region boundaries)
 * too, and we want the column to round-trip as WKT/EWKT text at the app boundary
 * (the app validates/builds geometries with a spatial lib, not Drizzle). So we
 * define one small `customType` factory that emits the exact DDL
 * `geometry(<Subtype>,4326)` and treats the value as a string (EWKT/WKT or GeoJSON
 * cast by the caller). This keeps the helper domain-free and covers every subtype.
 *
 * Indexing: every geo column wants a GIST index — declare it in the table's index
 * callback (Drizzle: `index("..._geo_gist").using("gist", t.col)`), per §1.
 *
 * Requires the PostGIS extension. The platform migration enables it
 * (`CREATE EXTENSION IF NOT EXISTS postgis`).
 */
import { customType } from "drizzle-orm/pg-core";

type GeometrySubtype = "Point" | "Polygon" | "MultiPolygon" | "Geometry";

/**
 * Internal factory: a PostGIS geometry column of a given subtype at SRID 4326.
 * The JS-side value is a `string` (WKT/EWKT, e.g. `SRID=4326;POINT(75.85 22.71)`).
 */
function geometryColumn(subtype: GeometrySubtype) {
  // data = string (WKT/EWKT) both ways; PostGIS parses WKT/EWKT on input and the
  // query layer wraps reads with ST_AsEWKT where a textual form is wanted. No
  // toDriver/fromDriver needed — the identity passthrough is the default.
  return customType<{ data: string; driverData: string }>({
    dataType() {
      return `geometry(${subtype},4326)`;
    },
  });
}

const pointType = geometryColumn("Point");
const polygonType = geometryColumn("Polygon");
const multiPolygonType = geometryColumn("MultiPolygon");

/** `geometry(Point,4326)` — a single coordinate (property location, gps capture). */
export function geoPoint(name: string) {
  return pointType(name);
}

/** `geometry(Polygon,4326)` — a simple boundary. */
export function geoPolygon(name: string) {
  return polygonType(name);
}

/**
 * `geometry(MultiPolygon,4326)` — administrative boundaries (a district/ward is
 * frequently a multipolygon). doc 10 §4 types `geo_regions.boundary` as
 * MultiPolygon, so this is the one geo_regions uses.
 */
export function geoMultiPolygon(name: string) {
  return multiPolygonType(name);
}
