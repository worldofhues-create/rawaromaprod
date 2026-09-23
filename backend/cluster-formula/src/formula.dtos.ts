/**
 * formula vault DTOs — zod bodies for the catalog masters, the seal flow (ingredients +
 * stage ingredients carry the SENSITIVE material_id + percentage in the REQUEST only; they
 * are sealed before they ever touch a column), approval/copy lifecycle, and the generic
 * cursor list query. The service fills the meta tail (status, created_by/updated_by from the
 * principal). Timestamps arrive as ISO strings; soft refs are plain uuids.
 */
import { z } from 'zod';

/** Generic cursor list query shared by every table. */
export const listQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuery>;

/** GET /v1/vault/materials — the Vault draft editor's material picker (vault.* gated). */
export const searchMaterialsQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchMaterialsQuery = z.infer<typeof searchMaterialsQuery>;

/* ── formula type master ──────────────────────────────────────────────── */

export const createFormulaType = z.object({
  typeCode: z.string(),
  typeName: z.string(),
});
export type CreateFormulaType = z.infer<typeof createFormulaType>;

/* ── formula master (creates the vault + per-formula DEK) ──────────────── */

export const createFormula = z.object({
  formulaTypeId: z.string().uuid().optional(),
  formulaCode: z.string(),
  formulaName: z.string(),
  formulaOwnerUserId: z.string().uuid().optional(),
});
export type CreateFormula = z.infer<typeof createFormula>;

/* ── formula version ──────────────────────────────────────────────────── */

export const createVersion = z.object({
  formulaId: z.string().uuid(),
  versionNumber: z.number().int().min(1),
});
export type CreateVersion = z.infer<typeof createVersion>;

/* ── sealed ingredients (the sensitive pair lives in the body only) ───── */

const ingredientSecret = z.object({
  materialId: z.string().uuid(),
  percentage: z.number().positive(),
  sequenceNo: z.number().int().optional(),
});

/** POST /v1/formula-versions/:id/ingredients — one or more ingredients to SEAL. */
export const addIngredients = z.object({
  ingredients: z.array(ingredientSecret).min(1),
});
export type AddIngredients = z.infer<typeof addIngredients>;

/* ── stages + sealed stage ingredients ────────────────────────────────── */

export const createStage = z.object({
  formulaVersionId: z.string().uuid(),
  stageName: z.string(),
  sequenceNo: z.number().int().optional(),
  stageInstructions: z.string().optional(),
});
export type CreateStage = z.infer<typeof createStage>;

/** POST /v1/formula-stages/:id/ingredients — one or more stage ingredients to SEAL. */
export const addStageIngredients = z.object({
  ingredients: z.array(ingredientSecret).min(1),
});
export type AddStageIngredients = z.infer<typeof addStageIngredients>;

/* ── access policy ────────────────────────────────────────────────────── */

export const createAccessPolicy = z.object({
  formulaId: z.string().uuid(),
  roleId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  accessLevel: z.number().int().optional(),
});
export type CreateAccessPolicy = z.infer<typeof createAccessPolicy>;

/* ── document mapping ─────────────────────────────────────────────────── */

export const createDocumentMapping = z.object({
  formulaId: z.string().uuid(),
  formulaVersionId: z.string().uuid().optional(),
  documentTypeId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
});
export type CreateDocumentMapping = z.infer<typeof createDocumentMapping>;

/* ── owner/vault-role read: the actual (decrypted) recipe ──────────────── */

/** POST .../actual body — §109.6/§109.8 requires a caller-supplied purpose/reason on every
 * plaintext read, recorded on the audit row (see VaultService.AuditInput). Security review
 * item 9: this travels in the request BODY, never the query string — a decrypt reason in a
 * URL lands in access logs, browser history, and any upstream proxy's request log, none of
 * which should ever see it. (The route itself changed GET → POST for the same reason: an
 * HTTP GET has no standard body.) */
export const actualReadBody = z.object({
  reason: z.string().trim().min(3, 'a decrypt reason is required (min 3 characters)').max(500),
});
export type ActualReadBody = z.infer<typeof actualReadBody>;

/* ── approval (flow body) ─────────────────────────────────────────────── */

export const approveVersion = z.object({
  approvalLevel: z.number().int().optional(),
  remarks: z.string().optional(),
});
export type ApproveVersion = z.infer<typeof approveVersion>;

/** POST .../reject — the approve/reject pairing (§107 vault_approver, §109.8 lifecycle). */
export const rejectVersion = z.object({
  remarks: z.string().min(3, 'a rejection reason is required (min 3 characters)').max(2000),
});
export type RejectVersion = z.infer<typeof rejectVersion>;

/* ── §109.8 lifecycle transitions (submit-for-review / lock / supersede) ───────────────── */

/** POST .../submit-for-review — DRAFT|VERSIONED → REVIEW. */
export const submitForReview = z.object({
  remarks: z.string().max(2000).optional(),
});
export type SubmitForReview = z.infer<typeof submitForReview>;

/** POST .../lock — APPROVED → LOCKED (the further, explicit freeze after approval). */
export const lockVersion = z.object({
  remarks: z.string().max(2000).optional(),
});
export type LockVersion = z.infer<typeof lockVersion>;

/* ── copy request (flow bodies) ───────────────────────────────────────── */

export const createCopyRequest = z.object({
  sourceFormulaId: z.string().uuid(),
  sourceVersionId: z.string().uuid().optional(),
  targetFormulaId: z.string().uuid().optional(),
  copyNotes: z.string().optional(),
});
export type CreateCopyRequest = z.infer<typeof createCopyRequest>;

export const decideCopyRequest = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  copyNotes: z.string().optional(),
});
export type DecideCopyRequest = z.infer<typeof decideCopyRequest>;
