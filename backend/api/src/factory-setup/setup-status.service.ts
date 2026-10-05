/**
 * SetupStatusService (FACTORY-SETUP) — the factory setup checklist's counts, read-only, over the
 * shared PG_CLIENT (the BFF read-model idiom: raw cross-schema SQL, nothing written). The same
 * numbers serve the Factory console's checklist and ALEMBIC's Admin summary card (the signed
 * catalogue endpoint's `op: 'status'`).
 *
 * Never a formula's content: "formulas linked" counts DISTINCT catalogue products whose
 * product_master.formula_id is set — the link FormulaSetupService (lane vaultsetup) writes when
 * Ruh drafts a shell or a person links one. "approved" asks the Vault, over the signed internal
 * channel, only whether each linked formula has an approved version (VaultApiClient.formulaLabels:
 * code + version number); null when the Vault is not wired or did not answer.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '@core/backend-kernel';
import { VaultApiClient } from '@ra/cluster-formula';

export interface SetupCounts {
  catalogue: { products: number; singleChemicals: number; blends: number; lastSyncedAt: string | null };
  packs: { ok: number; needsDensity: number; counted: number; unreadable: number; productsNeedingDensity: number };
  qcSpecs: { products: number; approved: number; proposed: number; missing: number };
  racks: { zones: number; racks: number; bins: number; proposed: boolean };
  pickLight: { mode: 'off' | 'simulator' | 'http' | 'unset' };
  /** approved: linked products whose formula has an approved version (null = the Vault did not answer). */
  formulas: { linked: number; products: number; approved: number | null };
  blocked: { unknownSku: number; noFormulaLink: number; noApprovedFormula: number; qtyNotInKg: number };
}

const n = (v: unknown): number => Number(v ?? 0) || 0;
const LABEL_CHUNK = 200;

@Injectable()
export class SetupStatusService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    @Optional() @Inject(VaultApiClient) private readonly vault?: Pick<VaultApiClient, 'formulaLabels'>,
  ) {}

  /** How many of these linked products' formulas have an approved version; null when unknown. */
  private async approvedCount(links: Array<{ formula_id: string }>): Promise<number | null> {
    if (links.length === 0) return 0;
    if (!this.vault) return null;
    const ids = [...new Set(links.map((l) => l.formula_id))];
    const approved = new Set<string>();
    try {
      for (let i = 0; i < ids.length; i += LABEL_CHUNK) {
        const res = await this.vault.formulaLabels({ formulaIds: ids.slice(i, i + LABEL_CHUNK), formulaVersionIds: [] }, { timeoutMs: 5000 });
        for (const f of res.formulas) if (f.approvedVersion) approved.add(f.formulaId);
      }
    } catch {
      return null;
    }
    return links.filter((l) => approved.has(l.formula_id)).length;
  }

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

    // One row per catalogue PRODUCT (several ALEMBIC SKUs may land on one product).
    const formulaRows = (await this.sql`
      select distinct p.product_id::text as product_id, p.formula_id::text as formula_id
        from bridge.catalogue_item c join packaging.product_master p on p.product_id = c.product_id`) as Array<{ product_id: string; formula_id: string | null }>;
    const links = formulaRows.filter((r): r is { product_id: string; formula_id: string } => !!r.formula_id);
    const formulas = { products: formulaRows.length, linked: links.length, approved: await this.approvedCount(links) };

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
      formulas,
      blocked: { unknownSku: n(blocked?.unknown_sku), noFormulaLink: n(blocked?.no_link), noApprovedFormula: n(blocked?.no_approved), qtyNotInKg: n(blocked?.qty) },
    };
  }
}
