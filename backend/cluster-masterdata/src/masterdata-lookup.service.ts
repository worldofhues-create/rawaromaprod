/**
 * MasterdataLookupService — in-cluster implementation of the `MasterdataLookup` public
 * port. Provided under `MASTERDATA_LOOKUP` so consumers depend only on the interface,
 * never on a concrete class. Each resolver is a single keyed select returning id +
 * code/name refs.
 */
import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, inArray } from 'drizzle-orm';
import {
  MASTERDATA_DB,
  masterdataSchema,
  type MasterdataDb,
} from './cluster-masterdata.tokens.js';
import type { AliasRef, MasterdataLookup, MaterialRef } from './public-api.js';

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
}
