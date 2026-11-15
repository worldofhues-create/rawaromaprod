/**
 * RP-BE-1 — two reads the RAC OS Vault console draws that the Vault box had no route for (ALEMBIC
 * rp-relay.md Part 4.3: Overview, Version draft). Vault box only (VAULT_MODE=true).
 *
 * LD-261: these are METADATA ONLY. A formula is its code, name, version number, status, who and when;
 * an ingredient line, a material id inside a recipe, a percentage, a quantity or a sealed payload is
 * never selected here (no read touches formula_ingredients or formula_stage_ingredients except to
 * COUNT rows). The decrypted recipe stays at POST /v1/formula-versions/:id/actual, @NoRelay.
 *
 * Every read writes one row to the hash-chained formula.audit_events before it answers (the Vault's
 * own trail, VaultService.writeStandaloneAudit), so a Vault view through the relay is recorded on the
 * Vault itself as well as by ALEMBIC.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AuthPrincipal } from '@core/backend-kernel';
import { FORMULA_DB, type FormulaDb } from '../formula.tokens.js';
import { VaultService } from '../vault.service.js';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NEEDED_ON_MAIN = 'Formulas waiting to be written for an order are main-box data (GET /v1/produce/formula-needs); the Vault never calls the main box.';
export const MATERIALS_BY_SEARCH = 'The material master is searched, never listed: GET /v1/vault/materials?q=.';

function rows(r: unknown): Row[] {
  return (Array.isArray(r) ? r : ((r as { rows?: Row[] }).rows ?? [])) as Row[];
}

@Injectable()
export class VaultDeskService {
  constructor(@Inject(FORMULA_DB) private readonly db: FormulaDb, private readonly vault: VaultService) {}

  private async audit(p: AuthPrincipal, action: string, entityId: string | null, req?: { requestId?: string | null; ip?: string | null }) {
    await this.vault.writeStandaloneAudit({
      actorId: p.userId, action, entityType: 'vault_desk', entityId,
      requestId: req?.requestId ?? null, ip: req?.ip ?? null, result: 'allow',
    });
  }

  /** Overview: tiles by version status, versions waiting for review, and the formula directory. */
  async overview(p: AuthPrincipal, req?: { requestId?: string | null; ip?: string | null }) {
    await this.audit(p, 'formula.vault.overview_read', null, req);
    const [tiles] = rows(await this.db.execute(sql`
      select count(*) filter (where status in ('APPROVED', 'LOCKED'))::int as approved,
             count(*) filter (where status = 'REVIEW')::int as waiting,
             count(*) filter (where status = 'DRAFT')::int as drafts
        from formula.formula_version`));
    const waiting = rows(await this.db.execute(sql`
      select v.formula_version_id::text as "formulaVersionId", v.formula_id::text as "formulaId", m.formula_code as "formulaCode",
             m.formula_name as "formulaName", v.version_number as "versionNumber", v.status,
             v.submitted_by as "submittedBy", v.submitted_dt::text as "submittedDt", v.created_by as "createdBy",
             (select count(*)::int from formula.formula_ingredients i where i.formula_version_id = v.formula_version_id) as "sealedLines"
        from formula.formula_version v join formula.formula_master m on m.formula_id = v.formula_id
       where v.status = 'REVIEW'
       order by v.submitted_dt asc nulls last
       limit 100`));
    const formulas = rows(await this.db.execute(sql`
      select m.formula_id::text as "formulaId", m.formula_code as "formulaCode", m.formula_name as "formulaName", m.status,
             lv.version_number as "latestVersionNumber", lv.status as "latestVersionStatus", lv.updated_dt::text as "latestVersionUpdatedDt",
             av.formula_version_id::text as "approvedVersionId", av.version_number as "approvedVersionNumber"
        from formula.formula_master m
        left join lateral (select version_number, status, updated_dt from formula.formula_version x where x.formula_id = m.formula_id order by version_number desc limit 1) lv on true
        left join lateral (select formula_version_id, version_number from formula.formula_version y where y.formula_id = m.formula_id and y.status in ('APPROVED', 'LOCKED') order by version_number desc limit 1) av on true
       order by m.formula_code nulls last
       limit 200`));
    return {
      tiles: { approved: tiles?.approved ?? 0, waiting: tiles?.waiting ?? 0, drafts: tiles?.drafts ?? 0, needed: null },
      neededNote: NEEDED_ON_MAIN,
      waiting,
      formulas,
    };
  }

  /**
   * Version draft: the versions a new draft may start from (approved or locked), metadata only. With
   * `base` (a version id) only that formula's versions. The draft itself, with its lines, is written
   * in the Vault's own screen (POST /v1/formula-versions is @NoRelay).
   */
  async versionDraft(p: AuthPrincipal, baseRaw: unknown, req?: { requestId?: string | null; ip?: string | null }) {
    const base = typeof baseRaw === 'string' && UUID.test(baseRaw) ? baseRaw : null;
    await this.audit(p, 'formula.vault.version_draft_read', base, req);
    const bases = rows(await this.db.execute(sql`
      select v.formula_version_id::text as "formulaVersionId", v.formula_id::text as "formulaId", m.formula_code as "formulaCode",
             m.formula_name as "formulaName", v.version_number as "versionNumber", v.status, v.approved_by as "approvedBy",
             v.approved_dt::text as "approvedDt"
        from formula.formula_version v join formula.formula_master m on m.formula_id = v.formula_id
       where v.status in ('APPROVED', 'LOCKED')
         and (${base}::uuid is null or v.formula_id = (select formula_id from formula.formula_version b where b.formula_version_id = ${base}::uuid))
       order by m.formula_code nulls last, v.version_number desc
       limit 200`));
    return { bases, materials: null, materialsNote: MATERIALS_BY_SEARCH };
  }
}
