/**
 * UUIDv7 generation.
 *
 * UUIDv7 is time-sortable, index-friendly (monotonic-ish prefix → fewer B-tree
 * page splits than v4) and non-enumerable — exactly the trade doc 10 §1 asks for.
 * We use the `uuidv7` npm package (tiny, zero-dep) for application-side generation
 * and lean on Postgres for the DEFAULT so a row gets an id even if inserted by a
 * path that bypasses the app (seeds, manual SQL, other services on the same DB).
 *
 * Postgres-side default
 * ---------------------
 * Postgres 17 ships `uuidv7()` ONLY from PG 18; on 17 there is no built-in, so the
 * canonical approach is a tiny SQL function installed by the kernel's first
 * migration (see `UUIDV7_SQL`). `baseColumns()` references it via
 * `.default(sql\`uuidv7()\`)`. If a deployment prefers app-generated ids only, drop
 * the default and pass `id: uuidv7()` explicitly — both are valid.
 */
import { uuidv7 as generate } from "uuidv7";

/** Generate a fresh UUIDv7 string (application side). */
export function uuidv7(): string {
  return generate();
}

/**
 * SQL that installs a `uuidv7()` function in the current database.
 *
 * Pure pl/pgsql, no extensions required — safe on a locked-down managed PG 17.
 * Idempotent (CREATE OR REPLACE). Run once, early, in the kernel migration set so
 * every schema's `baseColumns().id` default resolves. Drawn from the widely-used
 * Kyle Hubert / Buildkite reference implementation (RFC 9562 layout: 48-bit ms
 * timestamp, version nibble, 74 random bits).
 */
export const UUIDV7_SQL = `
CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$
  -- Build a v7 UUID: unix_ts_ms (48 bits) | ver (4) | rand_a (12) | var (2) | rand_b (62)
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
$$ LANGUAGE sql VOLATILE;
`.trim();
