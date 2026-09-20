/**
 * platform seed entry — idempotent (doc 10 §1).
 *
 * Run via `pnpm --filter @core/data-platform seed`. Requires DATABASE_URL (platform
 * role). Seeds geo_region_types + Indore regions + master_types + master_items
 * (incl. measurement units). All ON CONFLICT DO NOTHING; re-running is a no-op.
 * Masters + geo seed in ALL envs.
 */
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { type SeedStep, resolveEnv, runSeeds } from "@core/data-kernel";
import {
  geoRegionTypes,
  geoRegions,
  masterTypes,
} from "./schema/index.js";
import { INDIA_REGION_TYPES, INDORE_REGIONS } from "./seeds/geo.js";
import {
  MASTER_TYPES,
  MEASUREMENT_UNITS,
  STARTER_MASTER_ITEMS,
  type SeedMasterItem,
} from "./seeds/masters.js";

const ALL_MASTER_ITEMS: SeedMasterItem[] = [
  ...MEASUREMENT_UNITS,
  ...STARTER_MASTER_ITEMS,
];

export const platformSeedSteps: SeedStep[] = [
  {
    name: "platform: india geo region types",
    run: async (db) => {
      await db
        .insert(geoRegionTypes)
        .values(INDIA_REGION_TYPES.map((r) => ({ ...r })))
        .onConflictDoNothing({ target: geoRegionTypes.key });
    },
  },
  {
    name: "platform: indore region rows (self-tree)",
    run: async (db) => {
      // Insert in array order (parents precede children). Resolve parent_id by name
      // + type within this seed run; idempotent by (type_key, name) match.
      const seedKeyToId = new Map<string, string>();
      for (const region of INDORE_REGIONS) {
        const parentId = region.parentKey
          ? seedKeyToId.get(region.parentKey) ?? null
          : null;
        const centroidSql = region.centroid
          ? sql`ST_GeomFromEWKT(${region.centroid})`
          : sql`NULL`;
        // geo_regions has no natural unique constraint, so ON CONFLICT can't help.
        // Idempotency = SELECT-then-INSERT keyed on (type_key, name, parent_id).
        const existing = await db.execute<{ id: string }>(sql`
          SELECT id FROM platform.geo_regions
          WHERE type_key = ${region.typeKey} AND name = ${region.name}
          ${parentId ? sql`AND parent_id = ${parentId}` : sql`AND parent_id IS NULL`}
          LIMIT 1
        `);
        let id = existing[0]?.id;
        if (!id) {
          const inserted = await db.execute<{ id: string }>(sql`
            INSERT INTO platform.geo_regions (type_key, parent_id, name, code, centroid, is_active)
            VALUES (${region.typeKey}, ${parentId}, ${region.name}, ${region.code}, ${centroidSql}, true)
            RETURNING id
          `);
          id = inserted[0]?.id;
        }
        if (id) seedKeyToId.set(region.seedKey, id);
      }
    },
  },
  {
    name: "platform: master types",
    run: async (db) => {
      await db
        .insert(masterTypes)
        .values(MASTER_TYPES.map((m) => ({ ...m })))
        .onConflictDoNothing({ target: masterTypes.key });
    },
  },
  {
    name: "platform: master items (incl. measurement units)",
    run: async (db) => {
      // First pass: insert all items without parent_id wiring.
      const seedKeyToId = new Map<string, string>();
      for (const item of ALL_MASTER_ITEMS) {
        const rows = await db.execute<{ id: string }>(sql`
          INSERT INTO platform.master_items (type_key, key, label, sort_order, metadata, is_active)
          VALUES (
            ${item.typeKey}, ${item.key}, ${item.label},
            ${item.sortOrder ?? 0},
            ${item.metadata ? sql`${JSON.stringify(item.metadata)}::jsonb` : sql`NULL`},
            true
          )
          ON CONFLICT (type_key, key) DO NOTHING
          RETURNING id
        `);
        let id = rows[0]?.id;
        if (!id) {
          const existing = await db.execute<{ id: string }>(sql`
            SELECT id FROM platform.master_items
            WHERE type_key = ${item.typeKey} AND key = ${item.key} LIMIT 1
          `);
          id = existing[0]?.id;
        }
        if (id) seedKeyToId.set(`${item.typeKey}:${item.key}`, id);
      }
      // Second pass: wire parent_id for hierarchical items.
      for (const item of ALL_MASTER_ITEMS) {
        if (!item.parentKey) continue;
        const childId = seedKeyToId.get(`${item.typeKey}:${item.key}`);
        const parentId = seedKeyToId.get(`${item.typeKey}:${item.parentKey}`);
        if (childId && parentId) {
          await db.execute(sql`
            UPDATE platform.master_items
            SET parent_id = ${parentId}
            WHERE id = ${childId} AND parent_id IS DISTINCT FROM ${parentId}
          `);
        }
      }
    },
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to run platform seeds");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, {
    schema: { geoRegionTypes, geoRegions, masterTypes },
  });
  try {
    const env = resolveEnv();
    const results = await runSeeds(db, platformSeedSteps, env);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`[platform seed] ${r.status.padEnd(7)} ${r.name}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
