/**
 * ApprovalsService — the formula lifecycle gates: version approval (which LOCKS the recipe
 * and makes it selectable for production) and the copy-request workflow.
 *
 *   approveVersion → record FORMULA_APPROVAL, flip the version to APPROVED (immutable), set
 *                    FORMULA_MASTER.current_version_id, write event-hist + a hash-chained
 *                    audit row, and emit `formula.version.approved` (ids only) via the
 *                    transactional outbox — production's "Formula Selection" reacts to it.
 *   copy request   → create (PENDING) → decide (APPROVED/REJECTED); on APPROVED with a target,
 *                    emit `formula.copy.approved`. (Physical re-seal copy is a later increment;
 *                    the request ledger + signal are complete here.)
 *
 * Everything mutating runs in one transaction so the outbox event commits iff its cause did.
 */
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, lt } from 'drizzle-orm';
import { recordOutbox, type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { FORMULA_DB, formulaSchema, type FormulaDb } from '../formula.tokens.js';
import { formulaEvents } from '../formula.events.js';
import { VaultService } from '../vault.service.js';
import { paginate, type Page } from '../formulas/formulas.service.js';
import type {
  ApproveVersion,
  CreateCopyRequest,
  DecideCopyRequest,
  ListQuery,
  RejectVersion,
} from '../formula.dtos.js';

const { formulaVersion, formulaMaster, formulaApproval, formulaCopyRequest, formulaEventHist, outbox } =
  formulaSchema;

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(FORMULA_DB) private readonly db: FormulaDb,
    private readonly vault: VaultService,
  ) {}

  /* ── approve + lock a version ─────────────────────────────────────── */

  async approveVersion(versionId: string, body: ApproveVersion, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      // Lock the version row so a concurrent/replayed approve can't double-emit the signal.
      const version = (
        await tx
          .select()
          .from(formulaVersion)
          .where(eq(formulaVersion.formulaVersionId, versionId))
          .for('update')
          .limit(1)
      )[0];
      if (!version) throw new NotFoundException(`formula_version not found: ${versionId}`);
      // DRAFT-only (not just "not already APPROVED" — a REJECTED version must not be
      // resurrected by approving it later; it needs a new successor version, same as an
      // already-APPROVED one needs a new version to change anything, §109.8).
      if (version.status !== 'DRAFT') {
        throw new ConflictException(
          `formula_version already decided (status=${version.status}): ${versionId}`,
        );
      }
      // §108 SoD: "Formula author cannot final-approve same protected version." `createdBy`
      // is stamped by createVersion() at draft time — that's this version's author. Checked
      // server-side regardless of role/permission (the UI hides the button too, but the
      // server must refuse it even if the button were bypassed).
      if (version.createdBy && version.createdBy === principal.userId) {
        await this.vault.writeStandaloneAudit({
          actorId: principal.userId,
          action: 'formula.version.approve.self_refused',
          entityType: 'formula_version',
          entityId: versionId,
          result: 'refuse',
        });
        throw new ForbiddenException(
          'segregation of duties: the author of this formula version cannot approve it (§108)',
        );
      }

      const now = new Date();

      const approval = (
        await tx
          .insert(formulaApproval)
          .values({
            formulaApprovalId: uuidv7(),
            formulaVersionId: versionId,
            approverUserId: principal.userId,
            approvalLevel: body.approvalLevel ?? 1,
            approvalStatus: 'APPROVED',
            approvedDt: now,
            remarks: body.remarks ?? null,
            status: 'APPROVED',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!approval) throw new Error('insert failed: formula_approval');

      const updated = (
        await tx
          .update(formulaVersion)
          .set({ status: 'APPROVED', approvedBy: principal.userId, approvedDt: now, updatedBy: principal.userId })
          .where(eq(formulaVersion.formulaVersionId, versionId))
          .returning()
      )[0];
      if (!updated) throw new Error('update failed: formula_version');

      if (version.formulaId) {
        await tx
          .update(formulaMaster)
          .set({ currentVersionId: versionId, updatedBy: principal.userId })
          .where(eq(formulaMaster.formulaId, version.formulaId));
      }

      await tx.insert(formulaEventHist).values({
        formulaEventHistId: uuidv7(),
        formulaId: version.formulaId,
        formulaVersionId: versionId,
        eventType: 'VERSION_APPROVED',
        eventDt: now,
        performedBy: principal.userId,
        remarks: body.remarks ?? null,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      if (version.formulaId) {
        await recordOutbox(
          tx,
          outbox,
          formulaEvents.versionApproved,
          {
            formulaId: version.formulaId,
            formulaVersionId: versionId,
            versionNumber: version.versionNumber ?? 0,
          },
          version.formulaId,
        );
      }

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: 'formula.version.approved',
        entityType: 'formula_version',
        entityId: versionId,
      });

      return { version: updated, approval };
    });
  }

  /**
   * POST /v1/formula-versions/:id/reject — the approve/reject pairing (§107 vault_approver,
   * §109.8). Same DRAFT-only guard as approve (a version already decided, either way, can't
   * be re-decided — create a successor version instead). Unlike approve, rejection carries no
   * SoD restriction: a version's own author rejecting their own submission isn't the
   * conflict-of-interest §108 guards against (only self-APPROVAL is). Does not touch
   * FORMULA_MASTER.current_version_id (rejection never becomes the selectable version).
   */
  async rejectVersion(versionId: string, body: RejectVersion, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const version = (
        await tx
          .select()
          .from(formulaVersion)
          .where(eq(formulaVersion.formulaVersionId, versionId))
          .for('update')
          .limit(1)
      )[0];
      if (!version) throw new NotFoundException(`formula_version not found: ${versionId}`);
      if (version.status !== 'DRAFT') {
        throw new ConflictException(
          `formula_version already decided (status=${version.status}): ${versionId}`,
        );
      }

      const now = new Date();

      const approval = (
        await tx
          .insert(formulaApproval)
          .values({
            formulaApprovalId: uuidv7(),
            formulaVersionId: versionId,
            approverUserId: principal.userId,
            approvalLevel: 1,
            approvalStatus: 'REJECTED',
            approvedDt: now,
            remarks: body.remarks,
            status: 'REJECTED',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!approval) throw new Error('insert failed: formula_approval');

      const updated = (
        await tx
          .update(formulaVersion)
          .set({ status: 'REJECTED', updatedBy: principal.userId })
          .where(eq(formulaVersion.formulaVersionId, versionId))
          .returning()
      )[0];
      if (!updated) throw new Error('update failed: formula_version');

      await tx.insert(formulaEventHist).values({
        formulaEventHistId: uuidv7(),
        formulaId: version.formulaId,
        formulaVersionId: versionId,
        eventType: 'VERSION_REJECTED',
        eventDt: now,
        performedBy: principal.userId,
        remarks: body.remarks,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: 'formula.version.rejected',
        entityType: 'formula_version',
        entityId: versionId,
        reason: body.remarks,
      });

      return { version: updated, approval };
    });
  }

  async listApprovals(query: ListQuery): Promise<Page<typeof formulaApproval.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaApproval)
      .where(query.cursor ? lt(formulaApproval.formulaApprovalId, query.cursor) : undefined)
      .orderBy(desc(formulaApproval.formulaApprovalId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaApprovalId);
  }

  /* ── copy request lifecycle ───────────────────────────────────────── */

  async createCopyRequest(body: CreateCopyRequest, principal: AuthPrincipal) {
    const row = (
      await this.db
        .insert(formulaCopyRequest)
        .values({
          formulaCopyRequestId: uuidv7(),
          sourceFormulaId: body.sourceFormulaId,
          sourceVersionId: body.sourceVersionId ?? null,
          targetFormulaId: body.targetFormulaId ?? null,
          requestedBy: principal.userId,
          requestedDt: new Date(),
          copyNotes: body.copyNotes ?? null,
          status: 'PENDING',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new Error('insert failed: formula_copy_request');
    return row;
  }

  async decideCopyRequest(id: string, body: DecideCopyRequest, principal: AuthPrincipal) {
    const request = (
      await this.db
        .select()
        .from(formulaCopyRequest)
        .where(eq(formulaCopyRequest.formulaCopyRequestId, id))
        .limit(1)
    )[0];
    if (!request) throw new NotFoundException(`formula_copy_request not found: ${id}`);

    return this.db.transaction(async (tx) => {
      const updated = (
        await tx
          .update(formulaCopyRequest)
          .set({
            status: body.decision,
            approvedBy: principal.userId,
            approvedDt: new Date(),
            copyNotes: body.copyNotes ?? request.copyNotes,
            updatedBy: principal.userId,
          })
          .where(eq(formulaCopyRequest.formulaCopyRequestId, id))
          .returning()
      )[0];
      if (!updated) throw new Error('update failed: formula_copy_request');

      if (body.decision === 'APPROVED' && request.sourceFormulaId && request.targetFormulaId) {
        await recordOutbox(
          tx,
          outbox,
          formulaEvents.copyApproved,
          {
            formulaCopyRequestId: id,
            sourceFormulaId: request.sourceFormulaId,
            targetFormulaId: request.targetFormulaId,
          },
          id,
        );
      }

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: `formula.copy.${body.decision.toLowerCase()}`,
        entityType: 'formula_copy_request',
        entityId: id,
      });

      return updated;
    });
  }

  async listCopyRequests(query: ListQuery): Promise<Page<typeof formulaCopyRequest.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaCopyRequest)
      .where(query.cursor ? lt(formulaCopyRequest.formulaCopyRequestId, query.cursor) : undefined)
      .orderBy(desc(formulaCopyRequest.formulaCopyRequestId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaCopyRequestId);
  }
}
