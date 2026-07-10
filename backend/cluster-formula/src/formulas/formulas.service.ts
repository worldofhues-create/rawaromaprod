/**
 * FormulasService — the formula document + its sealed recipe. Owns:
 *   create        → FORMULA_MASTER + a FORMULA_VAULT row holding a fresh per-formula DEK,
 *                   wrapped under the KEK (KmsPort). The DEK is generated, wrapped, stored,
 *                   and discarded from memory — only the wrapped form persists.
 *   createVersion → a DRAFT FORMULA_VERSION (immutable once approved).
 *   addIngredients / addStageIngredients → SEAL { materialId, percentage } under the formula
 *                   DEK before it ever touches a column; only enc_payload/iv/tag + sequence
 *                   persist. Allowed on DRAFT versions only.
 *   getActualFormula → the OWNER read of the real recipe; edge-gated by `formula:actual:read`
 *                   and funneled through VaultService (approved-only + mandatory audit).
 *
 * List/get of ingredients returns STRUCTURE ONLY (ids + sequence) — never the ciphertext, so
 * the recipe shape is browsable but nothing sealed crosses the wire outside the audited read.
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { type AuthPrincipal } from '@core/backend-kernel';
import { uuidv7 } from '@core/data-kernel';
import { FORMULA_DB, formulaSchema, type FormulaDb } from '../formula.tokens.js';
import { KMS_PORT, type KmsPort } from '../crypto/kms.port.js';
import { newDek, seal } from '../crypto/vault-crypto.js';
import { VaultService } from '../vault.service.js';
import type {
  AddIngredients,
  AddStageIngredients,
  CreateFormula,
  CreateStage,
  CreateVersion,
  ListQuery,
} from '../formula.dtos.js';

const {
  formulaMaster,
  formulaVersion,
  formulaVault,
  formulaIngredients,
  formulaStageMaster,
  formulaStageIngredients,
  formulaEventHist,
  formulaAccessPolicy,
} = formulaSchema;

/** The drizzle transaction handle for this cluster's schema (for the in-tx locked checks). */
type Tx = Parameters<Parameters<FormulaDb['transaction']>[0]>[0];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class FormulasService {
  constructor(
    @Inject(FORMULA_DB) private readonly db: FormulaDb,
    @Inject(KMS_PORT) private readonly kms: KmsPort,
    private readonly vault: VaultService,
  ) {}

  /** Verify the tamper-evidence of the vault access-audit chain (owner-only). */
  verifyAuditChain() {
    return this.vault.verifyAuditChain();
  }

  /* ── formula master (+ vault) ─────────────────────────────────────── */

  /** Create the formula and its vault row (fresh DEK, wrapped under the KEK). */
  async createFormula(body: CreateFormula, principal: AuthPrincipal) {
    const wrapped = this.kms.wrapDek(newDek());

    return this.db.transaction(async (tx) => {
      const formulaId = uuidv7();
      const formula = (
        await tx
          .insert(formulaMaster)
          .values({
            formulaId,
            formulaTypeId: body.formulaTypeId ?? null,
            formulaCode: body.formulaCode,
            formulaName: body.formulaName,
            formulaOwnerUserId: body.formulaOwnerUserId ?? principal.userId,
            currentVersionId: null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!formula) throw new Error('insert failed: formula_master');

      await tx.insert(formulaVault).values({
        formulaVaultId: uuidv7(),
        formulaId,
        encryptionKeyRef: this.kms.keyRef,
        vaultLocation: JSON.stringify(wrapped),
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: 'formula.created',
        entityType: 'formula_master',
        entityId: formulaId,
      });

      // Return the master only — the vault row (key material) never leaves the cluster.
      return formula;
    });
  }

  async listFormulas(query: ListQuery): Promise<Page<typeof formulaMaster.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaMaster)
      .where(query.cursor ? lt(formulaMaster.formulaId, query.cursor) : undefined)
      .orderBy(desc(formulaMaster.formulaId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaId);
  }

  async getFormula(id: string) {
    return (
      await this.db.select().from(formulaMaster).where(eq(formulaMaster.formulaId, id)).limit(1)
    )[0] ?? null;
  }

  /* ── formula version ──────────────────────────────────────────────── */

  async createVersion(body: CreateVersion, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const versionId = uuidv7();
      const row = (
        await tx
          .insert(formulaVersion)
          .values({
            formulaVersionId: versionId,
            formulaId: body.formulaId,
            versionNumber: body.versionNumber,
            status: 'DRAFT',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!row) throw new Error('insert failed: formula_version');

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: 'formula.version.created',
        entityType: 'formula_version',
        entityId: versionId,
      });
      return row;
    });
  }

  async listVersions(query: ListQuery): Promise<Page<typeof formulaVersion.$inferSelect>> {
    const rows = await this.db
      .select()
      .from(formulaVersion)
      .where(query.cursor ? lt(formulaVersion.formulaVersionId, query.cursor) : undefined)
      .orderBy(desc(formulaVersion.formulaVersionId))
      .limit(query.limit + 1);
    return paginate(rows, query.limit, (r) => r.formulaVersionId);
  }

  async getVersion(id: string) {
    return (
      await this.db
        .select()
        .from(formulaVersion)
        .where(eq(formulaVersion.formulaVersionId, id))
        .limit(1)
    )[0] ?? null;
  }

  /**
   * Authoritative, race-free draft check: re-select the version FOR UPDATE inside the open
   * transaction so an approval committing between the pre-check and the seal cannot let
   * ingredients land on a now-locked version (TOCTOU). Returns the locked row.
   */
  private async lockDraftVersionTx(tx: Tx, versionId: string) {
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
      throw new ForbiddenException('formula version is not DRAFT — recipe is locked');
    }
    return version;
  }

  /* ── seal flow: version ingredients ──────────────────────────────── */

  /** POST /v1/formula-versions/:id/ingredients — seal each ingredient under the formula DEK. */
  async addIngredients(versionId: string, body: AddIngredients, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const version = await this.lockDraftVersionTx(tx, versionId);
      const dek = await this.vault.getDekForFormula(version.formulaId, tx);

      const values = body.ingredients.map((ing) => {
        const sealed = seal({ materialId: ing.materialId, percentage: ing.percentage }, dek);
        return {
          formulaIngredientsId: uuidv7(),
          formulaVersionId: versionId,
          encPayload: sealed.encPayload,
          encIv: sealed.encIv,
          encTag: sealed.encTag,
          sequenceNo: ing.sequenceNo ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        };
      });
      await tx.insert(formulaIngredients).values(values);

      await tx.insert(formulaEventHist).values({
        formulaEventHistId: uuidv7(),
        formulaId: version.formulaId,
        formulaVersionId: versionId,
        eventType: 'INGREDIENTS_SEALED',
        eventDt: new Date(),
        performedBy: principal.userId,
        remarks: `${values.length} ingredient(s) sealed`,
        status: 'ACTIVE',
        createdBy: principal.userId,
        updatedBy: principal.userId,
      });

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: 'formula.ingredients.sealed',
        entityType: 'formula_version',
        entityId: versionId,
      });

      return { sealed: values.length };
    });
  }

  /** Structure-only listing — ids + sequence, never ciphertext. */
  async listIngredients(versionId: string) {
    return this.db
      .select({
        formulaIngredientsId: formulaIngredients.formulaIngredientsId,
        formulaVersionId: formulaIngredients.formulaVersionId,
        sequenceNo: formulaIngredients.sequenceNo,
        status: formulaIngredients.status,
      })
      .from(formulaIngredients)
      .where(eq(formulaIngredients.formulaVersionId, versionId))
      .orderBy(asc(formulaIngredients.sequenceNo));
  }

  /* ── stages + sealed stage ingredients ───────────────────────────── */

  async createStage(body: CreateStage, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      await this.lockDraftVersionTx(tx, body.formulaVersionId);
      const stageId = uuidv7();
      const row = (
        await tx
          .insert(formulaStageMaster)
          .values({
            formulaStageId: stageId,
            formulaVersionId: body.formulaVersionId,
            stageName: body.stageName,
            sequenceNo: body.sequenceNo ?? null,
            stageInstructions: body.stageInstructions ?? null,
            status: 'ACTIVE',
            createdBy: principal.userId,
            updatedBy: principal.userId,
          })
          .returning()
      )[0];
      if (!row) throw new Error('insert failed: formula_stage_master');

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: 'formula.stage.created',
        entityType: 'formula_stage',
        entityId: stageId,
      });
      return row;
    });
  }

  async listStages(versionId: string) {
    return this.db
      .select()
      .from(formulaStageMaster)
      .where(eq(formulaStageMaster.formulaVersionId, versionId))
      .orderBy(asc(formulaStageMaster.sequenceNo));
  }

  /** POST /v1/formula-stages/:id/ingredients — seal each stage ingredient under the DEK. */
  async addStageIngredients(stageId: string, body: AddStageIngredients, principal: AuthPrincipal) {
    return this.db.transaction(async (tx) => {
      const stage = (
        await tx
          .select()
          .from(formulaStageMaster)
          .where(eq(formulaStageMaster.formulaStageId, stageId))
          .limit(1)
      )[0];
      if (!stage) throw new NotFoundException(`formula_stage not found: ${stageId}`);
      const version = await this.lockDraftVersionTx(tx, stage.formulaVersionId!);
      const dek = await this.vault.getDekForFormula(version.formulaId, tx);

      const values = body.ingredients.map((ing) => {
        const sealed = seal({ materialId: ing.materialId, percentage: ing.percentage }, dek);
        return {
          formulaStageIngredientsId: uuidv7(),
          formulaStageId: stageId,
          encPayload: sealed.encPayload,
          encIv: sealed.encIv,
          encTag: sealed.encTag,
          sequenceNo: ing.sequenceNo ?? null,
          status: 'ACTIVE',
          createdBy: principal.userId,
          updatedBy: principal.userId,
        };
      });
      await tx.insert(formulaStageIngredients).values(values);

      await this.vault.writeAudit(tx, {
        actorId: principal.userId,
        action: 'formula.stage_ingredients.sealed',
        entityType: 'formula_stage',
        entityId: stageId,
      });

      return { sealed: values.length };
    });
  }

  /* ── owner read: the actual (decrypted) recipe ───────────────────── */

  /**
   * GET /v1/formula-versions/:id/actual — the OWNER path. Edge-gated by `formula:actual:read`,
   * and additionally scoped PER-FORMULA here: the caller must be the formula's owner or hold an
   * active FORMULA_ACCESS_POLICY grant for it — the coarse permission alone does not unlock
   * every owner's recipe. Returns the real material_id + %; the audited, locked-only decrypt
   * happens in VaultService. 404 if the version doesn't exist.
   */
  async getActualFormula(versionId: string, principal: AuthPrincipal) {
    const version = await this.getVersion(versionId);
    if (!version) throw new NotFoundException(`formula_version not found: ${versionId}`);
    await this.assertFormulaAccess(version.formulaId, principal);

    const ingredients = await this.vault.decryptVersion(versionId, {
      actorId: principal.userId,
      action: 'formula.actual.read',
      entityType: 'formula_version',
      entityId: versionId,
    });
    if (!ingredients) throw new NotFoundException(`formula_version not found: ${versionId}`);
    return { formulaVersionId: versionId, ingredients };
  }

  /**
   * Per-formula authorization for the decrypted read: the caller is the formula owner, OR an
   * active user-scoped FORMULA_ACCESS_POLICY row grants them this formula. (Role-scoped policies
   * await role-id in the principal — the JWT carries role keys, not role ids; tracked.)
   */
  private async assertFormulaAccess(formulaId: string | null, principal: AuthPrincipal) {
    if (!formulaId) throw new ForbiddenException('formula access denied');
    const formula = await this.getFormula(formulaId);
    if (!formula) throw new NotFoundException(`formula_master not found: ${formulaId}`);
    if (formula.formulaOwnerUserId === principal.userId) return;

    const grant = (
      await this.db
        .select({ id: formulaAccessPolicy.formulaAccessPolicyId })
        .from(formulaAccessPolicy)
        .where(
          and(
            eq(formulaAccessPolicy.formulaId, formulaId),
            eq(formulaAccessPolicy.userId, principal.userId),
            eq(formulaAccessPolicy.status, 'ACTIVE'),
          ),
        )
        .limit(1)
    )[0];
    if (!grant) throw new ForbiddenException('formula access denied — not owner and no access policy');
  }
}

/** Shared cursor pagination — desc(pk), limit+1 → {items, nextCursor}. */
export function paginate<T>(rows: T[], limit: number, pk: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? pk(last) : null;
  return { items, nextCursor };
}
