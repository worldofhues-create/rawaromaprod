/**
 * FormulaSetupService — the FACTORY box's half of "every product gets a formula" (lane vaultsetup;
 * owner decisions 2026-10-05: products are MOSTLY BLENDED IN-HOUSE; "Ruh drafts, one person
 * approves"). This box never sees formula content: it knows products, materials and formula ids
 * and codes, and asks the Vault for everything else.
 *
 *   listProducts   every product with its formula state (none / linked / approved), the
 *                  catalogue's single-chemical/blend classification when one is known
 *                  (PRODUCT_KIND_SOURCE — see below), and the material a single-chemical product
 *                  would be sealed from (the material whose code equals the product code).
 *   createShells   for the chosen products with no formula: mint a Ruh token for this ONE call
 *                  (ServicePrincipalService — refused until two owners granted Ruh `formulator`),
 *                  ask the Vault to draft the shells AS RUH (POST /v1/formula-shells: the Vault's
 *                  own guards check Ruh's permissions, its audit names Ruh), then link each product
 *                  to its shell's formula — `product_master.formula_id` set only where it is still
 *                  empty, one audit row per link, one transaction. Re-running it is safe: the Vault
 *                  returns the shell it already drafted, and a linked product is skipped.
 *   linkFormula    the guarded, audited way to set or REPLACE an existing product's formula
 *                  (owner/production: packaging:product_formula_link:write) — the generic edit
 *                  route still cannot touch formula_id (edit.service.ts). The formula must exist in
 *                  the Vault. Before/after/reason land in packaging.audit_events.
 *   directory      GET /v1/formulas on this box (it had none — the Factory's "New product" Formula
 *                  dropdown called a route that did not exist): code, status, approved/latest
 *                  version number from the Vault. Never a formula name.
 *
 * Why link at shell time rather than on approval: a product linked to a not-yet-approved formula is
 * exactly the state the produce flow already handles (NO_APPROVED_FORMULA + the formula_needed
 * alert to the formula roles), and it makes "which formula is this product's" a fact from the
 * first click. Approval then needs no main-box event at all: ProducePlanService asks the Vault for
 * the formula's current approved version each time it plans.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { VaultApiClient, type FormulaDirectoryPage, type ShellKind, type ShellResult } from '@ra/cluster-formula';
import { ServicePrincipalService } from '@ra/cluster-org';
import { FORMULA_SETUP_DB, PRODUCT_KIND_SOURCE, type FormulaSetupDb, type ProductKindSource } from './formula-setup.tokens.js';

export interface SetupProduct {
  productId: string;
  productCode: string | null;
  productName: string | null;
  status: string | null;
  skuCodes: string[];
  formulaId: string | null;
  formula: {
    formulaCode: string | null;
    approvedVersionNumber: number | null;
  } | null;
  /** none: no formula linked · linked: a formula, not approved yet · approved: production-ready. */
  state: 'none' | 'linked' | 'approved';
  /** The catalogue's classification, when the catalogue has one (else the owner picks). */
  catalogueKind: ShellKind | null;
  /** The material a single-chemical product is sealed from: the one material whose code equals
   *  the product code (null when there is none, or more than one). */
  material: { materialId: string; materialCode: string | null; materialName: string | null } | null;
}

export interface ShellOutcome {
  productId: string;
  productCode: string | null;
  outcome: 'created' | 'existing' | 'already_linked' | 'error';
  formulaId?: string | null;
  formulaCode?: string | null;
  state?: string;
  linked?: boolean;
  error?: string;
}

const MAX_PRODUCTS = 2000;
const LABEL_CHUNK = 200;

@Injectable()
export class FormulaSetupService {
  constructor(
    @Inject(FORMULA_SETUP_DB) private readonly db: FormulaSetupDb,
    @Inject(ServicePrincipalService) private readonly principals: Pick<ServicePrincipalService, 'mintVaultToken'>,
    @Optional() @Inject(VaultApiClient)
    private readonly vault?: Pick<VaultApiClient, 'formulaLabels' | 'formulaDirectory' | 'createFormulaShellsAs'>,
    @Optional() @Inject(PRODUCT_KIND_SOURCE) private readonly kinds?: ProductKindSource,
  ) {}

  private requireVault() {
    if (!this.vault) throw new ServiceUnavailableException('The Formula Vault is not reachable from this box.');
    return this.vault;
  }

  async listProducts(): Promise<{ items: SetupProduct[]; vaultError: string | null }> {
    const rows = (await this.db.execute(sql`
      select p.product_id::text as product_id, p.product_code, p.product_name, p.status, p.formula_id::text as formula_id,
             coalesce((select array_agg(s.sku_code order by s.sku_code) from packaging.product_sku s
                        where s.product_id = p.product_id and s.sku_code is not null), '{}') as sku_codes,
             mc.material_id, mc.material_code, mc.material_name, mc.n as material_matches
        from packaging.product_master p
        left join lateral (
          select min(m.material_id::text) as material_id, min(m.material_code) as material_code,
                 min(m.material_name) as material_name, count(*)::int as n
            from masterdata.material m
           where p.product_code is not null and lower(btrim(m.material_code)) = lower(btrim(p.product_code))
        ) mc on true
       order by p.product_code nulls last
       limit ${MAX_PRODUCTS}
    `)) as unknown as Array<{
      product_id: string; product_code: string | null; product_name: string | null; status: string | null;
      formula_id: string | null; sku_codes: string[]; material_id: string | null; material_code: string | null;
      material_name: string | null; material_matches: number;
    }>;

    const formulaIds = [...new Set(rows.map((r) => r.formula_id).filter((f): f is string => !!f))];
    const labels = new Map<string, { formulaCode: string | null; approvedVersionNumber: number | null }>();
    let vaultError: string | null = null;
    if (formulaIds.length > 0) {
      try {
        const vault = this.requireVault();
        for (let i = 0; i < formulaIds.length; i += LABEL_CHUNK) {
          const res = await vault.formulaLabels({ formulaIds: formulaIds.slice(i, i + LABEL_CHUNK), formulaVersionIds: [] }, { timeoutMs: 8000 });
          for (const f of res.formulas) {
            labels.set(f.formulaId, { formulaCode: f.formulaCode, approvedVersionNumber: f.approvedVersion?.versionNumber ?? null });
          }
        }
      } catch (err) {
        vaultError = (err as Error).message;
      }
    }
    const kinds = this.kinds ? await this.kinds.kindsFor(rows.map((r) => r.product_id)) : new Map<string, ShellKind>();

    const items = rows.map((r): SetupProduct => {
      const label = r.formula_id ? labels.get(r.formula_id) ?? null : null;
      return {
        productId: r.product_id,
        productCode: r.product_code,
        productName: r.product_name,
        status: r.status,
        skuCodes: r.sku_codes ?? [],
        formulaId: r.formula_id,
        formula: label,
        state: !r.formula_id ? 'none' : label?.approvedVersionNumber != null ? 'approved' : 'linked',
        catalogueKind: kinds.get(r.product_id) ?? null,
        material: r.material_matches === 1 && r.material_id
          ? { materialId: r.material_id, materialCode: r.material_code, materialName: r.material_name }
          : null,
      };
    });
    return { items, vaultError };
  }

  async createShells(
    body: { products: Array<{ productId: string; kind: ShellKind; materialId?: string | null }> },
    principal: AuthPrincipal,
  ): Promise<{ results: ShellOutcome[] }> {
    const vault = this.requireVault();
    const ids = [...new Set(body.products.map((p) => p.productId))];
    const rows = (await this.db.execute(sql`
      select p.product_id::text as product_id, p.product_code, p.product_name, p.formula_id::text as formula_id
        from packaging.product_master p where p.product_id in ${ids}
    `)) as unknown as Array<{ product_id: string; product_code: string | null; product_name: string | null; formula_id: string | null }>;
    const byId = new Map(rows.map((r) => [r.product_id, r]));

    const results: ShellOutcome[] = [];
    const inputs: Array<{ productId: string; productCode: string; productName: string | null; kind: ShellKind; materialId: string | null }> = [];
    for (const want of body.products) {
      const p = byId.get(want.productId);
      if (!p) { results.push({ productId: want.productId, productCode: null, outcome: 'error', error: 'No such product.' }); continue; }
      if (!p.product_code) { results.push({ productId: p.product_id, productCode: null, outcome: 'error', error: 'The product has no code.' }); continue; }
      if (p.formula_id) { results.push({ productId: p.product_id, productCode: p.product_code, outcome: 'already_linked', formulaId: p.formula_id }); continue; }
      let materialId: string | null = null;
      if (want.kind === 'single_chemical') {
        try {
          materialId = await this.materialFor(p.product_code, want.materialId ?? null);
        } catch (err) {
          results.push({ productId: p.product_id, productCode: p.product_code, outcome: 'error', error: (err as Error).message });
          continue;
        }
      }
      inputs.push({ productId: p.product_id, productCode: p.product_code, productName: p.product_name, kind: want.kind, materialId });
    }
    if (inputs.length === 0) return { results };

    const { token } = await this.principals.mintVaultToken(`draft formula shells for ${inputs.length} product(s)`);
    const drafted = await vault.createFormulaShellsAs(token, { products: inputs });

    const linked = await this.db.transaction(async (tx) => {
      const out = new Map<string, boolean>();
      for (const r of drafted.results) {
        if (!r.formulaId || r.outcome === 'error') continue;
        const input = inputs.find((i) => i.productId === r.productId);
        const updated = (await tx.execute(sql`
          update packaging.product_master
             set formula_id = ${r.formulaId}::uuid, updated_by = ${principal.userId}, updated_dt = now()
           where product_id = ${r.productId}::uuid and formula_id is null
          returning product_id
        `)) as unknown as unknown[];
        out.set(r.productId, updated.length > 0);
        if (updated.length > 0) {
          await this.auditLink(tx, principal, r.productId, null, r.formulaId, `formula shell drafted by Ruh (${input?.kind ?? r.kind ?? 'unknown'})`);
        }
      }
      return out;
    });

    for (const r of drafted.results as ShellResult[]) {
      results.push({
        productId: r.productId,
        productCode: r.productCode,
        outcome: r.outcome,
        formulaId: r.formulaId ?? null,
        formulaCode: r.formulaCode ?? null,
        state: r.state,
        linked: linked.get(r.productId) ?? false,
        ...(r.error ? { error: r.error } : {}),
      });
    }
    return { results };
  }

  /** The product's own material: the one the caller named (must exist), else the one material
   *  whose code equals the product code. */
  private async materialFor(productCode: string, named: string | null): Promise<string> {
    if (named) {
      const hit = (await this.db.execute(sql`select material_id::text as id from masterdata.material where material_id = ${named}::uuid`)) as unknown as Array<{ id: string }>;
      if (!hit[0]) throw new BadRequestException('The chosen material does not exist.');
      return hit[0].id;
    }
    const hits = (await this.db.execute(sql`
      select material_id::text as id from masterdata.material where lower(btrim(material_code)) = lower(btrim(${productCode})) limit 2
    `)) as unknown as Array<{ id: string }>;
    if (hits.length !== 1) {
      throw new BadRequestException(hits.length === 0
        ? `No material has the code ${productCode} — pick the product's material, or classify it as a blend.`
        : `More than one material has the code ${productCode} — pick the product's material.`);
    }
    return hits[0]!.id;
  }

  async linkFormula(productId: string, body: { formulaId: string; reason: string }, principal: AuthPrincipal) {
    const vault = this.requireVault();
    const labels = await vault.formulaLabels({ formulaIds: [body.formulaId], formulaVersionIds: [] }, { timeoutMs: 8000 });
    const formula = labels.formulas.find((f) => f.formulaId === body.formulaId);
    if (!formula) throw new NotFoundException('No such formula in the Vault.');
    return this.db.transaction(async (tx) => {
      const row = ((await tx.execute(sql`
        select product_id::text as product_id, product_code, formula_id::text as formula_id
          from packaging.product_master where product_id = ${productId}::uuid for update
      `)) as unknown as Array<{ product_id: string; product_code: string | null; formula_id: string | null }>)[0];
      if (!row) throw new NotFoundException('No such product.');
      if (row.formula_id === body.formulaId) {
        return { productId, productCode: row.product_code, formulaId: body.formulaId, formulaCode: formula.formulaCode, changed: false };
      }
      await tx.execute(sql`
        update packaging.product_master set formula_id = ${body.formulaId}::uuid, updated_by = ${principal.userId}, updated_dt = now()
         where product_id = ${productId}::uuid
      `);
      await this.auditLink(tx, principal, productId, row.formula_id, body.formulaId, body.reason);
      return {
        productId,
        productCode: row.product_code,
        formulaId: body.formulaId,
        formulaCode: formula.formulaCode,
        previousFormulaId: row.formula_id,
        changed: true,
      };
    });
  }

  async directory(limit: number, cursor?: string | null): Promise<FormulaDirectoryPage> {
    return this.requireVault().formulaDirectory(limit, cursor);
  }

  private async auditLink(
    tx: Parameters<Parameters<FormulaSetupDb['transaction']>[0]>[0],
    principal: AuthPrincipal,
    productId: string,
    before: string | null,
    after: string,
    reason: string,
  ): Promise<void> {
    await tx.execute(sql`
      insert into packaging.audit_events (actor_id, action, entity_type, entity_id, before, after)
      values (${principal.userId}::uuid, 'packaging.product.formula_linked', 'product_master', ${productId}::uuid,
              ${JSON.stringify({ formulaId: before })}::jsonb, ${JSON.stringify({ formulaId: after, reason })}::jsonb)
    `);
  }
}
