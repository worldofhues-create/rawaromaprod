/**
 * MasterdataLookupService — in-cluster implementation of the `MasterdataLookup` public
 * port. Provided under `MASTERDATA_LOOKUP` so consumers depend only on the interface,
 * never on a concrete class. Each resolver is a single keyed select returning id +
 * code/name refs.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  MASTERDATA_DB,
  masterdataSchema,
  type MasterdataDb,
} from './cluster-masterdata.tokens.js';
import { materialMatchKey, type AliasRef, type MasterdataLookup, type MaterialRef } from './public-api.js';
import { MATERIAL_SEARCH_POOL, rankMaterials } from './rank-materials.js'; // RAC-CODES-RP-2

const { material, rmAlias } = masterdataSchema;

@Injectable()
export class MasterdataLookupService implements MasterdataLookup {
  constructor(@Inject(MASTERDATA_DB) private readonly db: MasterdataDb) {}

  async findMaterial(materialId: string): Promise<MaterialRef | null> {
    const row = (
      await this.db
        .select({
          materialId: material.materialId,
          materialCode: material.materialCode,
          materialName: material.materialName,
          uomId: material.uomId,
        })
        .from(material)
        .where(eq(material.materialId, materialId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findAliasForMaterial(materialId: string): Promise<AliasRef | null> {
    const row = (
      await this.db
        .select({ rmAliasId: rmAlias.rmAliasId, aliasName: rmAlias.aliasName })
        .from(rmAlias)
        .where(eq(rmAlias.materialId, materialId))
        .orderBy(desc(rmAlias.rmAliasId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  async findAliasesForMaterials(materialIds: string[]): Promise<Map<string, AliasRef>> {
    const out = new Map<string, AliasRef>();
    const unique = [...new Set(materialIds)];
    // Chunk the IN(...) list so a large response can't blow the bind-param limit / planner.
    const CHUNK = 500;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      // Ordered so the LATEST alias per material wins (first seen kept; uuidv7 PK is time-ordered).
      const rows = await this.db
        .select({
          materialId: rmAlias.materialId,
          rmAliasId: rmAlias.rmAliasId,
          aliasName: rmAlias.aliasName,
        })
        .from(rmAlias)
        .where(inArray(rmAlias.materialId, slice))
        .orderBy(desc(rmAlias.rmAliasId));
      for (const r of rows) {
        if (r.materialId && !out.has(r.materialId)) {
          out.set(r.materialId, { rmAliasId: r.rmAliasId, aliasName: r.aliasName });
        }
      }
    }
    return out;
  }

  /* RAC-CODES-RP-2: ranked by the ONE RAC search (packages/contracts/src/rac, a pinned copy of
     ALEMBIC's), so `RAC271150`, `RAC-60-1032`, an old code held as an rm_alias, and a typo all find
     what the storefront and the consoles find. The candidate pool is the material master (bounded):
     ranking needs the rows a plain ILIKE would miss -- a typo, or a code written another way. */
  async searchMaterials(query: string, limit: number): Promise<MaterialRef[]> {
    const q = query.trim();
    if (!q) return [];
    const cap = Math.max(1, Math.min(limit, 50));
    const rows = await this.db
      .select({
        materialId: material.materialId,
        materialCode: material.materialCode,
        materialName: material.materialName,
        uomId: material.uomId,
      })
      .from(material)
      .orderBy(material.materialCode)
      .limit(MATERIAL_SEARCH_POOL);
    const aliases = await this.db
      .select({ materialId: rmAlias.materialId, aliasName: rmAlias.aliasName })
      .from(rmAlias)
      .limit(MATERIAL_SEARCH_POOL * 4);
    return rankMaterials(rows, aliases, q, cap);
  }

  async matchMaterials(keys: string[]): Promise<MaterialRef[]> {
    const wanted = [...new Set(keys.map(materialMatchKey).filter(Boolean))].slice(0, 5000);
    if (wanted.length === 0) return [];
    // The same normal form as materialMatchKey, in SQL: trim, collapse whitespace, lower-case.
    const norm = (col: typeof material.materialCode | typeof material.materialName) =>
      sql`lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;
    return this.db
      .select({
        materialId: material.materialId,
        materialCode: material.materialCode,
        materialName: material.materialName,
        uomId: material.uomId,
      })
      .from(material)
      .where(or(sql`${norm(material.materialCode)} in ${wanted}`, sql`${norm(material.materialName)} in ${wanted}`))
      .orderBy(material.materialCode);
  }
}
