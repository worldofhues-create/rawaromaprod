/**
 * SetupStatusService (FACTORY-SETUP) — the factory setup checklist's counts, read-only, over the
 * shared PG_CLIENT (the BFF read-model idiom: raw cross-schema SQL, nothing written). The same
 * numbers serve the Factory console's checklist and ALEMBIC's Admin summary card (the signed
 * catalogue endpoint's `op: 'status'`).
 *
 * Never a formula: "formulas linked" is a COUNT of products whose product_master.formula_id is
 * set (the Vault lane writes that link); nothing about any formula is read.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';

export interface SetupCounts {
  catalogue: { products: number; singleChemicals: number; blends: number; lastSyncedAt: string | null };
  packs: { ok: number; needsDensity: number; counted: number; unreadable: number; productsNeedingDensity: number };
  qcSpecs: { products: number; approved: number; proposed: number; missing: number };
  racks: { zones: number; racks: number; bins: number; proposed: boolean };
  pickLight: { mode: 'off' | 'simulator' | 'http' | 'unset' };
  formulas: { linked: number; products: number };
  blocked: { unknownSku: number; noFormulaLink: number; noApprovedFormula: number; qtyNotInKg: number };
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

@Injectable()
export class SetupStatusService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  async counts(): Promise<SetupCounts> {
    const [cat] = (await this.sql`
      select count(*)::int as products,
             count(*) filter (where classification = 'single_chemical')::int as singles,
             count(*) filter (where classification = 'blend')::int as blends,
             max(synced_at) as last
        from bridge.catalogue_item`) as Array<{ products: number; singles: number; blends: number; last: Date | null }>;

    const [packs] = (await this.sql`
      select count(*) filter (where p->>'status' = 'ok')::int as ok,
             count(*) filter (where p->>'status' = 'needs_density')::int as needs,
             count(*) filter (where p->>'status' = 'counted')::int as counted,
             count(*) filter (where p->>'status' = 'unreadable')::int as unreadable,
             count(distinct c.alembic_sku_id) filter (where p->>'status' = 'needs_density')::int as products
        from bridge.catalogue_item c, jsonb_array_elements(c.pack_sizes) p`) as Array<Record<string, number>>;

    const [qc] = (await this.sql`
      select count(*)::int as products,
             count(s.product_qc_spec_id)::int as approved,
             count(*) filter (where s.product_qc_spec_id is null and exists (
               select 1 from production.setup_proposal sp where sp.kind = 'qc_spec' and sp.status = 'proposed' and sp.product_id = c.product_id))::int as proposed
        from bridge.catalogue_item c
        left join production.product_qc_spec s on s.product_id = c.product_id
       where c.product_id is not null`) as Array<{ products: number; approved: number; proposed: number }>;

    const [racks] = (await this.sql`
      select count(distinct z.zone_id)::int as zones, count(distinct r.rack_id)::int as racks, count(b.bin_id)::int as bins
        from location.bin_master b
        join location.shelf_master sh on sh.shelf_id = b.shelf_id
        join location.rack_master r on r.rack_id = sh.rack_id
        left join location.zone_master z on z.zone_id = r.zone_id`) as Array<{ zones: number; racks: number; bins: number }>;
    const [rackProposal] = (await this.sql`
      select 1 from production.setup_proposal where kind = 'rack_layout' and status = 'proposed' limit 1`) as unknown as unknown[];

    const [light] = (await this.sql`select mode from location.pick_light_config where id = 'default'`) as Array<{ mode: string }>;

    const [formulas] = (await this.sql`
      select count(*)::int as products, count(p.formula_id)::int as linked
        from bridge.catalogue_item c join packaging.product_master p on p.product_id = c.product_id`) as Array<{ products: number; linked: number }>;

    const [blocked] = (await this.sql`
      select count(*) filter (where lifecycle_status = 'REJECTED_MAPPING')::int as unknown_sku,
             count(*) filter (where lifecycle_status = 'ACCEPTED' and production_order_id is null and produce_block_reason = 'NO_FORMULA_LINK')::int as no_link,
             count(*) filter (where lifecycle_status = 'ACCEPTED' and production_order_id is null and produce_block_reason = 'NO_APPROVED_FORMULA')::int as no_approved,
             count(*) filter (where lifecycle_status = 'ACCEPTED' and production_order_id is null and produce_block_reason = 'QTY_NOT_IN_KG')::int as qty
        from bridge.production_requirement`) as Array<Record<string, number>>;

    return {
      catalogue: { products: n(cat?.products), singleChemicals: n(cat?.singles), blends: n(cat?.blends), lastSyncedAt: cat?.last ? new Date(cat.last).toISOString() : null },
      packs: { ok: n(packs?.ok), needsDensity: n(packs?.needs), counted: n(packs?.counted), unreadable: n(packs?.unreadable), productsNeedingDensity: n(packs?.products) },
      qcSpecs: { products: n(qc?.products), approved: n(qc?.approved), proposed: n(qc?.proposed), missing: Math.max(0, n(qc?.products) - n(qc?.approved) - n(qc?.proposed)) },
      racks: { zones: n(racks?.zones), racks: n(racks?.racks), bins: n(racks?.bins), proposed: Boolean(rackProposal) },
      pickLight: { mode: (light?.mode as SetupCounts['pickLight']['mode']) ?? 'unset' },
      formulas: { linked: n(formulas?.linked), products: n(formulas?.products) },
      blocked: { unknownSku: n(blocked?.unknown_sku), noFormulaLink: n(blocked?.no_link), noApprovedFormula: n(blocked?.no_approved), qtyNotInKg: n(blocked?.qty) },
    };
  }
}
