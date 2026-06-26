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

/* ── approval (flow body) ─────────────────────────────────────────────── */

export const approveVersion = z.object({
  approvalLevel: z.number().int().optional(),
  remarks: z.string().optional(),
});
export type ApproveVersion = z.infer<typeof approveVersion>;

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
