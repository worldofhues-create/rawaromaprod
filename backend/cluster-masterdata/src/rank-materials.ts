/**
 * RAC-CODES-RP-2 — rank materials with the ONE RAC search (pure, so it is tested without a DB).
 *
 * A material is indexed as a RAC search product: code = material_code, name = material_name, and
 * every rm_alias (old RAC code, Shopify handle, floor code) as a legacy key, so an old code still
 * finds the material. The ranking itself is packages/contracts/src/rac/search.ts, a sha256-pinned
 * copy of ALEMBIC's; nothing here scores anything.
 */
import { buildRacSearchIndex, searchRac } from '@core/contracts/rac';
import type { MaterialRef } from './public-api.js';

/** The material master is small; ranking needs the whole pool, bounded so it cannot run away. */
export const MATERIAL_SEARCH_POOL = 5000;

export function rankMaterials(
  rows: readonly MaterialRef[],
  aliases: readonly { materialId: string | null; aliasName: string | null }[],
  query: string,
  cap: number,
): MaterialRef[] {
  const byId = new Map(rows.map((r) => [r.materialId, r]));
  const alias = new Map<string, string[]>();
  for (const a of aliases) {
    if (!a.materialId || !a.aliasName || !byId.has(a.materialId)) continue;
    const l = alias.get(a.materialId) ?? [];
    l.push(a.aliasName);
    alias.set(a.materialId, l);
  }
  /* RAC search keys products by code; a material with no code is keyed by its id so it still ranks by name. */
  const keyOf = (r: MaterialRef): string => r.materialCode || r.materialId;
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const ix = buildRacSearchIndex(rows.map((r) => ({
    code: keyOf(r),
    category: '',
    name: r.materialName ?? '',
    variants: (alias.get(r.materialId) ?? []).map((k) => ({ code: keyOf(r), grade: 'MATERIAL', old_rac_sku: k })),
  })), { scope: 'console' });
  return searchRac(ix, query, { limit: cap }).map((h) => byKey.get(h.code)!).filter(Boolean);
}
