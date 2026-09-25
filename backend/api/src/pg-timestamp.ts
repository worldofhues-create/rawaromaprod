/**
 * Timestamps from raw SQL on the shared `PG_CLIENT` pool, whichever shape the driver hands back.
 *
 * DrizzleModule wraps that same postgres-js client in Drizzle (IAM_DB / PLATFORM_DB), and drizzle-orm's
 * postgres-js driver replaces the client's timestamp/timestamptz/date PARSERS and SERIALIZERS with a
 * pass-through (drizzle-orm/postgres-js/driver.js). So in the running API a raw `sql\`...\`` query gets a
 * timestamp column back as Postgres text ('2026-09-24 10:00:00.123+00'), not a Date, and a JS Date bound as a
 * parameter is no longer serialized at all (postgres-js throws on it). Plain clients (most tests) still see
 * Dates, which is how both went unnoticed: "automation alerts scan failed: r.updated_dt.toISOString is not a
 * function" (demo), and every tutorial progress write (RC7).
 */

/** ISO-8601 for a Date or Postgres timestamp text; never throws (unparseable text comes back as-is). */
export function isoOf(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** A real Date for a Date or Postgres timestamp text; null stays null. */
export function asDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  return v instanceof Date ? v : new Date(v);
}
