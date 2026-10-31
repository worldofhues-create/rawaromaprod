/**
 * FactorySetupService (FACTORY-SETUP, owner decisions 2026-10-05) — "Ruh drafts, one person
 * approves", the factory's half.
 *
 *   QC specs     Ruh's draft per factory product, fetched from ALEMBIC (documents first, then held
 *                facts, then a labelled estimate — AlembicDraftsClient). Stored here as a proposal;
 *                approval writes production.product_qc_spec through CoaService.upsertSpec — the
 *                QC screen's own write — AS THE APPROVING PERSON. Gate: the QC spec write
 *                permission (the qc role, and owner).
 *   Rack layout  zones by product family, sized from the catalogue's product count and the kilos
 *                ALEMBIC holds — an estimate, so a proposal. The approver may change the counts;
 *                acceptance builds it through ShelfLayoutService.importCsv (the Rack layout
 *                screen's own CSV path, idempotent: a bin that exists is left as it is). Gate: the
 *                rack/shelf/bin write permissions (the warehouse role, and owner).
 *
 * Nothing unapproved reaches a COA, a label or the floor: a COA reads product_qc_spec only, a
 * label's rack is a bin in location.bin_master only, and neither is written until approval.
 * Every decision is audited (bridge.audit_events, plus the write audit every mutating route gets).
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT, type AuthPrincipal } from '@core/backend-kernel';
import { CoaService } from '@ra/cluster-production';
import { ShelfLayoutService } from '../shelf/shelf-layout.service.js';
import { AlembicDraftsClient } from './alembic-drafts.client.js';
import {
  decide, layoutCsv, layoutBins, layoutProblems, planRackLayout, qcSource, readQcDraft, KG_PER_BIN, DEFAULT_SHELVES,
  DEFAULT_BINS, PROPOSER, type ProposalStatus, type RackLayout, type QcDraft,
} from './catalogue.contract.js';

export const QC_DRAFT_BATCH = 25;
const CSV_CHUNK_LINES = 1900;

const STATUSES = new Set(['proposed', 'approved', 'rejected', 'superseded', 'all']);

@Injectable()
export class FactorySetupService {
  constructor(
    @Inject(PG_CLIENT) private readonly sql: Sql,
    private readonly coa: CoaService,
    private readonly layout: ShelfLayoutService,
    private readonly alembic: AlembicDraftsClient,
  ) {}

  private async audit(principal: AuthPrincipal, action: string, entityId: string | null, after: unknown): Promise<void> {
    await this.sql`
      insert into bridge.audit_events (actor_id, action, entity_type, entity_id, after, occurred_at)
      values (${principal.userId}, ${action}, 'setup_proposal', ${entityId}, ${JSON.stringify(after)}::text::jsonb, now())`;
  }

  /* ── the catalogue, for the Vault lane and the screens ─────────────────────────────────── */

  async catalogue(limit = 2000) {
    const rows = await this.sql`
      select c.alembic_sku_id as "alembicSkuId", c.sku_code as "skuCode", c.name, c.classification,
             c.classification_basis as "classificationBasis", c.grade, c.cas_number as "casNumber", c.cas_source as "casSource",
             c.material_id as "materialId", c.floor_code as "floorCode", c.product_id as "productId",
             c.product_sku_id as "productSkuId", (p.formula_id is not null) as "formulaLinked", c.synced_at as "syncedAt"
        from bridge.catalogue_item c
        left join packaging.product_master p on p.product_id = c.product_id
       order by c.sku_code
       limit ${Math.min(Math.max(1, limit), 5000)}`;
    return { items: rows, nextCursor: null };
  }

  /* ── QC specs ─────────────────────────────────────────────────────────────────────────── */

  async listProposals(kind: 'qc_spec' | 'rack_layout', status = 'proposed') {
    const s = STATUSES.has(status) ? status : 'proposed';
    const rows = await this.sql`
      select sp.setup_proposal_id as "setupProposalId", sp.kind, sp.product_id as "productId", sp.subject_label as "subject",
             sp.payload, sp.source, sp.evidence, sp.proposer, sp.status, sp.proposed_dt as "proposedDt",
             sp.decided_by as "decidedBy", sp.decided_dt as "decidedDt", sp.decision_note as "decisionNote", sp.applied
        from production.setup_proposal sp
       where sp.kind = ${kind} and (${s} = 'all' or sp.status = ${s})
       order by (sp.status = 'proposed') desc, sp.subject_label
       limit 1000`;
    return { items: rows, nextCursor: null };
  }

  /** Ask Ruh (through ALEMBIC) for drafts for products with no spec and no open draft. */
  async draftQc(principal: AuthPrincipal, limit = QC_DRAFT_BATCH) {
    const todo = (await this.sql`
      select c.product_id::text as product_id, c.sku_code, c.name
        from bridge.catalogue_item c
       where c.product_id is not null
         and not exists (select 1 from production.product_qc_spec s where s.product_id = c.product_id)
         and not exists (select 1 from production.setup_proposal sp where sp.kind = 'qc_spec' and sp.status = 'proposed' and sp.product_id = c.product_id)
       order by c.sku_code
       limit ${Math.min(Math.max(1, limit), 50)}`) as unknown as Array<{ product_id: string; sku_code: string; name: string }>;
    if (todo.length === 0) return { drafted: 0, notDrafted: [], ai: 'not_needed', message: 'Every product already has a QC spec or a draft waiting.' };

    const [me] = (await this.sql`select alembic_subject from iam.user_master where user_id = ${principal.userId}::uuid limit 1`) as Array<{ alembic_subject: string | null }>;
    const answer = await this.alembic.qcDrafts(todo.map((t) => t.sku_code), me?.alembic_subject ?? null);
    if (!answer.ok) return { drafted: 0, notDrafted: todo.map((t) => ({ sku: t.sku_code, reason: answer.message })), ai: 'unavailable', message: answer.message };

    let drafted = 0;
    const notDrafted: Array<{ sku: string; reason: string }> = [];
    for (const t of todo) {
      const a = answer.items.find((x) => x.sku_code === t.sku_code);
      const draft = a ? readQcDraft(a.draft) : null;
      if (!draft) { notDrafted.push({ sku: t.sku_code, reason: a?.reason ?? 'Ruh had nothing to propose' }); continue; }
      const evidence = [...new Set(Object.values(draft).map((f) => (f as { evidence: string }).evidence))].join(' · ').slice(0, 4000);
      const inserted = await this.sql`
        insert into production.setup_proposal (kind, product_id, subject_label, payload, source, evidence, proposer, proposed_by)
        values ('qc_spec', ${t.product_id}::uuid, ${`${t.sku_code} — ${t.name}`.slice(0, 300)}, ${JSON.stringify(draft)}::text::jsonb,
                ${qcSource(draft)}, ${evidence}, ${PROPOSER}, ${principal.userId})
        on conflict (product_id) where status = 'proposed' and kind = 'qc_spec' do nothing
        returning setup_proposal_id`;
      if (inserted.length) drafted++;
    }
    await this.audit(principal, 'factory_setup.qc_drafted', null, { asked: todo.length, drafted, ai: answer.ai });
    return { drafted, notDrafted, ai: answer.ai, message: null };
  }

  /** Approve or reject QC drafts, each through the QC spec write, as `principal`. */
  async decideQc(ids: string[], decision: 'approve' | 'reject', note: string | null, principal: AuthPrincipal) {
    let approved = 0, rejected = 0;
    const refused: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const [p] = (await this.sql`
        select setup_proposal_id::text as id, product_id::text as product_id, status, payload, source
          from production.setup_proposal where setup_proposal_id = ${id}::uuid and kind = 'qc_spec'`) as unknown as Array<{ id: string; product_id: string; status: ProposalStatus; payload: unknown; source: string }>;
      if (!p) { refused.push({ id, reason: 'no such draft' }); continue; }
      const d = decide(p.status, decision);
      if (!d.ok) { refused.push({ id, reason: d.reason }); continue; }
      let applied: unknown = null;
      if (decision === 'approve') {
        const draft = readQcDraft(p.payload) as QcDraft | null;
        if (!draft) { refused.push({ id, reason: 'the draft is not a complete spec' }); continue; }
        const existing = await this.coa.getSpec(p.product_id);
        if (existing) {
          /* A person entered a spec while the draft waited: theirs stands. */
          await this.sql`update production.setup_proposal set status = 'superseded' where setup_proposal_id = ${id}::uuid and status = 'proposed'`;
          refused.push({ id, reason: 'this product already has a QC spec; the draft was set aside' });
          continue;
        }
        const spec = await this.coa.upsertSpec(p.product_id, {
          sgMin: draft.sg_min.value, sgMax: draft.sg_max.value,
          flashPointMinC: draft.flash_point_min_c.value, flashPointMaxC: draft.flash_point_max_c.value,
          shelfLifeMonths: draft.shelf_life_months.value,
          colourAppearanceStandard: draft.colour_appearance?.value ?? null, odourStandard: draft.odour?.value ?? null,
        }, principal);
        applied = { productQcSpecId: spec?.productQcSpecId ?? null };
      }
      const upd = await this.sql`
        update production.setup_proposal set status = ${d.next}, decided_by = ${principal.userId}, decided_dt = now(),
               decision_note = ${note}, applied = ${applied === null ? null : JSON.stringify(applied)}::text::jsonb
         where setup_proposal_id = ${id}::uuid and status = 'proposed' returning setup_proposal_id`;
      if (!upd.length) { refused.push({ id, reason: 'someone decided it a moment ago' }); continue; }
      await this.audit(principal, decision === 'approve' ? 'factory_setup.qc_approved' : 'factory_setup.qc_rejected', id,
        { productId: p.product_id, source: p.source, note, ...(applied ? { applied } : {}) });
      if (decision === 'approve') approved++; else rejected++;
    }
    return { approved, rejected, refused };
  }

  /* ── rack layout ──────────────────────────────────────────────────────────────────────── */

  async draftRacks(principal: AuthPrincipal) {
    const [open] = (await this.sql`select setup_proposal_id::text as id from production.setup_proposal where kind = 'rack_layout' and status = 'proposed' limit 1`) as Array<{ id: string }>;
    if (open) return { proposalId: open.id, created: false };
    const items = (await this.sql`select classification, grade, on_hand_kg::float as on_hand_kg from bridge.catalogue_item`) as unknown as Array<{ classification: 'single_chemical' | 'blend'; grade: string | null; on_hand_kg: number }>;
    if (items.length === 0) throw new ConflictException('The catalogue has not reached the factory yet, so there is nothing to size racks from. Send the catalogue from the sales system first.');
    const layout = planRackLayout(items.map((i) => ({ classification: i.classification, grade: i.grade, onHandKg: i.on_hand_kg })));
    const [existing] = (await this.sql`select count(*)::int as bins from location.bin_master`) as Array<{ bins: number }>;
    const evidence = `estimate: one bin per product plus one for every ${KG_PER_BIN} kg the sales system holds (about a drum a bin), `
      + `racks of ${DEFAULT_SHELVES} shelves × ${DEFAULT_BINS} bins, zones by product family, walked zone by zone. `
      + `${items.length} products in the catalogue; ${existing?.bins ?? 0} bins already laid out (an existing bin is kept as it is).`;
    const [row] = (await this.sql`
      insert into production.setup_proposal (kind, product_id, subject_label, payload, source, evidence, proposer, proposed_by)
      values ('rack_layout', null, 'Rack layout', ${JSON.stringify(layout)}::text::jsonb, 'estimate', ${evidence}, ${PROPOSER}, ${principal.userId})
      on conflict (kind) where status = 'proposed' and kind = 'rack_layout' do nothing
      returning setup_proposal_id::text as id`) as Array<{ id: string }>;
    await this.audit(principal, 'factory_setup.racks_drafted', row?.id ?? null, { zones: layout.zones.length, bins: layoutBins(layout) });
    return { proposalId: row?.id ?? null, created: Boolean(row) };
  }

  /**
   * Accept (with the approver's edited counts, when given) or reject the open rack layout.
   * Acceptance builds it through the existing CSV import, in chunks the importer accepts.
   */
  async decideRacks(id: string, decision: 'approve' | 'reject', edited: unknown, note: string | null, principal: AuthPrincipal) {
    const [p] = (await this.sql`
      select setup_proposal_id::text as id, status, payload from production.setup_proposal
       where setup_proposal_id = ${id}::uuid and kind = 'rack_layout'`) as unknown as Array<{ id: string; status: ProposalStatus; payload: RackLayout }>;
    if (!p) throw new NotFoundException('No such rack layout draft.');
    const d = decide(p.status, decision);
    if (!d.ok) throw new ConflictException(d.reason);
    let applied: Record<string, unknown> | null = null;
    let finalLayout: RackLayout = p.payload;
    if (decision === 'approve') {
      if (edited !== undefined && edited !== null) {
        const problems = layoutProblems(edited);
        if (problems.length) throw new BadRequestException(`The layout cannot be built as edited: ${problems.join(', ')}.`);
        finalLayout = edited as RackLayout;
      }
      const lines = layoutCsv(finalLayout).split('\n');
      const header = lines.shift() as string;
      let created = 0, existing = 0;
      const errors: unknown[] = [];
      for (let i = 0; i < lines.length; i += CSV_CHUNK_LINES) {
        const r = await this.layout.importCsv([header, ...lines.slice(i, i + CSV_CHUNK_LINES)].join('\n'), principal);
        created += r.created; existing += r.existing; errors.push(...r.errors);
      }
      applied = { created, existing, errors: errors.length, bins: layoutBins(finalLayout), racks: finalLayout.zones.reduce((n, z) => n + z.racks, 0) };
    }
    const upd = await this.sql`
      update production.setup_proposal set status = ${d.next}, decided_by = ${principal.userId}, decided_dt = now(),
             decision_note = ${note}, applied = ${applied === null ? null : JSON.stringify({ ...applied, layout: finalLayout })}::text::jsonb
       where setup_proposal_id = ${id}::uuid and status = 'proposed' returning setup_proposal_id`;
    if (!upd.length) throw new ConflictException('Someone decided this layout a moment ago.');
    await this.audit(principal, decision === 'approve' ? 'factory_setup.racks_approved' : 'factory_setup.racks_rejected', id, { note, ...(applied ? { applied } : {}) });
    return { status: d.next, applied };
  }
}
