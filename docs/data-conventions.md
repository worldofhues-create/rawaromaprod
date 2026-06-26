# Data conventions (the DB standard)

Every cluster and every project follows these. They make schemas consistent, auditable, and
**extraction-safe** (a cluster can move to its own database with no rewrite).

## Engine & isolation
- **PostgreSQL 17**, one database, **schema-per-cluster** (`iam`, `platform`, …).
- Each cluster connects with its **own PG role**, granted only its schema (security + boundary).
- **NO cross-schema foreign keys.** Cross-cluster references are **id-only soft references**;
  integrity is maintained by events, not DB FKs. FKs are allowed only *within* a schema. This single
  rule is what lets a cluster be lifted into another project or its own DB.

## Keys & base columns
- PK `id` = **UUIDv7** (time-sortable, non-enumerable). The public id is the same UUIDv7 — **no
  sequential integers anywhere** (anti-scraping). Human refs (invoice no.) are a separate `code`.
- Every table: `id`, `created_at`, `updated_at`, `created_by`, `updated_by` (via `baseColumns()`).
- **Soft delete** (`deleted_at` + partial index) only where recovery is needed; hard-delete elsewhere.
- **Money** = `bigint` minor units + `currency` (never float). **Geo** = PostGIS `geometry(...,4326)` +
  GIST index. **Flexible data** = `jsonb`, validated by zod at the app boundary.

## Cross-cutting tables (per schema, from `@core/data-kernel`)
- **`outbox`** — transactional outbox: write data + event in one tx; a worker drains it to the bus
  (in-proc now, broker at extraction). The reliability backbone.
- **`audit_events`** — append-only; **hash-chained** in trust/financial clusters.

## Naming
snake_case; plural tables; FK `<entity>_id`; booleans `is_`/`has_`; timestamps `_at`. Enums =
text + zod + master-data lookup for business-dynamic values; native PG enum only for fixed code sets.

## Migrations & seeds
- drizzle-kit, **forward-only**, one migration set per cluster.
- **Each cluster tracks its own migration state** (its own `__migrations_<cluster>` table) — clusters
  sharing one tracking table causes silent skips (the migrator advances a single high-water-mark).
- Seeds: idempotent, env-aware (masters/geo/roles in all envs; demo data dev/staging only).

## Generic engines (prefer over one-table-per-thing)
- **Geo** = a self-referencing `geo_regions` tree + `geo_region_types` lookup → any admin hierarchy /
  country, arbitrary depth, no schema change to add a level.
- **Master data** = `master_types` + `master_items` (+ `parent_id` for hierarchies, `metadata` jsonb)
  → every dropdown; adding a master is an INSERT, not a migration.

## Reuse tiers
`@core/data-kernel` (helpers) + `@core/data-iam` + `@core/data-platform` ship with the template —
auth, orgs, RBAC, flags, masters, geo for free. Domain clusters are project-specific but copy these
patterns (flexible tree, unified-anchor + detail tables, versioned-document engine).
