/**
 * CatalogueProductKindSource — the ProductKindSource (formula-setup.tokens.ts) that reads the
 * ALEMBIC catalogue's classification out of `bridge.catalogue_item` (lane catalogue-rp, migration
 * 2026-10-05-factory-setup.sql; docs/bridge/FACTORY_CATALOGUE.md).
 *
 * Per product it answers the catalogue's kind (`single_chemical` | `blend`), the plain-words basis
 * ALEMBIC gave for it, and — for a single chemical — the product's own material (`material_id`,
 * the material the catalogue sync created or linked under the same code), only when that material
 * still exists.
 *
 * Fail-safe rules:
 *   - a product the catalogue does not hold has NO classification (the owner chooses on screen);
 *   - several catalogue rows on one product that disagree on the kind give NO classification —
 *     never a guess, and never "single chemical" out of a disagreement;
 *   - several rows naming different materials give no catalogue material (the service then falls
 *     back to the one material whose code equals the product code).
 *
 * Read-only, ids and codes only — nothing about any formula.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { ShellKind } from '@ra/cluster-formula';
import { FORMULA_SETUP_DB, type FormulaSetupDb, type ProductClassification, type ProductKindSource } from './formula-setup.tokens.js';

const CHUNK = 500;

@Injectable()
export class CatalogueProductKindSource implements ProductKindSource {
  constructor(@Inject(FORMULA_SETUP_DB) private readonly db: FormulaSetupDb) {}

  async classify(productIds: string[]): Promise<Map<string, ProductClassification>> {
    const out = new Map<string, ProductClassification>();
    const ids = [...new Set(productIds)];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = (await this.db.execute(sql`
        select c.product_id::text as product_id,
               array_agg(distinct c.classification::text) as kinds,
               string_agg(distinct c.classification_basis, '; ') as basis,
               array_agg(distinct m.material_id::text) filter (where m.material_id is not null) as materials
          from bridge.catalogue_item c
          left join masterdata.material m on m.material_id = c.material_id
         where c.product_id in ${chunk}
         group by c.product_id
      `)) as unknown as Array<{ product_id: string; kinds: string[]; basis: string | null; materials: string[] | null }>;
      for (const r of rows) {
        if (r.kinds.length !== 1) continue; // the catalogue disagrees with itself: the owner decides
        const kind = r.kinds[0] as ShellKind;
        if (kind !== 'single_chemical' && kind !== 'blend') continue;
        const materials = r.materials ?? [];
        out.set(r.product_id, {
          kind,
          basis: r.basis,
          materialId: kind === 'single_chemical' && materials.length === 1 ? materials[0]! : null,
        });
      }
    }
    return out;
  }
}
